import type { Pool, PoolClient } from 'pg';
import { tables, fieldNames, type Table } from './catalog.js';
import { AppError,sourceNames, ports, sourceToken, type SourceName } from './config.js';
import type { Row } from './source-store.js';
import { initializeIntake,receiveFhir } from './fhir-intake.js';
import { initializeAnomalies } from './anomaly-store.js';

const sqlTable=(t:Table)=>`${t.source}.${t.name}`;
export const sourceHeaders=():Record<string,string>=>sourceToken ? {'x-api-key':sourceToken} : {};
export class HubStore {
  sourceStatus: Record<string,Row> = Object.fromEntries(sourceNames.map(source=>[source,{source,status:'starting',last_sync_at:null,error:null}]));
  syncing=false;
  onChange: (data:Row)=>void=()=>{};
  initialMessages?: (source:SourceName)=>{cursor:number;messages:Iterable<Row>};
  constructor(public pool:Pool){}
  async initialize(){
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS adt; CREATE SCHEMA IF NOT EXISTS lis; CREATE SCHEMA IF NOT EXISTS formulary;
      CREATE TABLE IF NOT EXISTS sync_cursors(source TEXT PRIMARY KEY,last_event_id BIGINT NOT NULL,last_sync_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS event_log(id BIGSERIAL PRIMARY KEY,source TEXT NOT NULL,source_event_id BIGINT NOT NULL,entity TEXT NOT NULL,record_key TEXT NOT NULL,operation TEXT NOT NULL,payload JSONB NOT NULL,occurred_at TIMESTAMPTZ NOT NULL,received_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(source,source_event_id));
      CREATE TABLE IF NOT EXISTS write_proposals(id TEXT PRIMARY KEY,source TEXT NOT NULL,entity TEXT NOT NULL,record JSONB NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at TIMESTAMPTZ NOT NULL DEFAULT now(),committed_record JSONB);
      CREATE TABLE IF NOT EXISTS chat_audit(id BIGSERIAL PRIMARY KEY,tool TEXT NOT NULL,arguments JSONB NOT NULL,outcome TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    for(const table of tables){
      await this.pool.query(`CREATE TABLE IF NOT EXISTS ${sqlTable(table)} (${table.fields.map(f=>`${f.name} ${f.type?'INTEGER':'TEXT'}`).join(',')},created_at TEXT,updated_at TEXT,record_version INTEGER,PRIMARY KEY(${table.keys.join(',')}))`);
      for(const field of table.search)await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_${table.source}_${table.name}_${field} ON ${sqlTable(table)}(${field})`);
    }
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_lis_cultures_date ON lis.cultures(sample_date);
      CREATE INDEX IF NOT EXISTS idx_assistant_patient_id ON adt.patients(lower(patient_id));
      CREATE INDEX IF NOT EXISTS idx_assistant_culture_id ON lis.cultures(lower(culture_id));
      CREATE INDEX IF NOT EXISTS idx_assistant_ward_code ON adt.wards(lower(ward_code));
      CREATE INDEX IF NOT EXISTS idx_assistant_isolate_id ON lis.isolates(lower(isolate_id));
      CREATE INDEX IF NOT EXISTS idx_assistant_ward_date ON lis.cultures(ward_code,sample_date DESC);
      CREATE INDEX IF NOT EXISTS idx_lis_ast_antibiotic ON lis.ast_results(antibiotic_code);
      CREATE INDEX IF NOT EXISTS idx_events_received ON event_log(id DESC);
      CREATE OR REPLACE VIEW dim_patient AS SELECT * FROM adt.patients;
      CREATE OR REPLACE VIEW dim_ward AS SELECT * FROM adt.wards;
      CREATE OR REPLACE VIEW dim_antibiotic AS SELECT * FROM formulary.antibiotics;
      CREATE OR REPLACE VIEW dim_organism AS SELECT DISTINCT organism FROM lis.isolates;
      CREATE OR REPLACE VIEW fact_culture AS SELECT c.*,p.sex,p.birth_year,p.home_area,w.ward_en,w.ward_fi,w.ward_type,w.institution,
        extract(isoyear from c.sample_date::date)::integer AS iso_year,extract(week from c.sample_date::date)::integer AS iso_week
        FROM lis.cultures c LEFT JOIN adt.patients p USING(patient_id) LEFT JOIN adt.wards w USING(ward_code);
      CREATE OR REPLACE VIEW fact_isolate AS SELECT i.*,c.patient_id,c.ward_code,c.sample_date,c.specimen FROM lis.isolates i LEFT JOIN lis.cultures c USING(culture_id);
      CREATE OR REPLACE VIEW fact_ast AS SELECT a.*,i.culture_id,i.organism,c.patient_id,c.ward_code,c.sample_date,c.specimen,ab.antibiotic,ab.antibiotic_fi,ab.class,ab.reported_for
        FROM lis.ast_results a LEFT JOIN lis.isolates i USING(isolate_id) LEFT JOIN lis.cultures c USING(culture_id) LEFT JOIN formulary.antibiotics ab USING(antibiotic_code);
      CREATE OR REPLACE VIEW patient_timeline AS SELECT c.patient_id,c.culture_id,c.sample_date,c.ward_code,c.specimen,c.status,c.result AS culture_result,
        i.isolate_id,i.organism,a.antibiotic_code,a.result AS susceptibility_result,a.guideline
        FROM lis.cultures c LEFT JOIN lis.isolates i USING(culture_id) LEFT JOIN lis.ast_results a USING(isolate_id);`);
    await initializeIntake(this);
    await initializeAnomalies(this.pool);
  }
  async upsert(client:PoolClient,table:Table,records:Row[]) {
    if(!records.length)return;
    const fields=[...fieldNames(table),'created_at','updated_at','record_version'];
    const updates=fields.filter(f=>!table.keys.includes(f)).map(f=>`${f}=EXCLUDED.${f}`).join(',');
    await client.query(`INSERT INTO ${sqlTable(table)} (${fields.join(',')}) SELECT ${fields.join(',')} FROM jsonb_populate_recordset(NULL::${sqlTable(table)},$1::jsonb) ON CONFLICT(${table.keys.join(',')}) DO UPDATE SET ${updates}`,[JSON.stringify(records)]);
  }
  async bootstrap(source:SourceName){
    const prior=await this.pool.query('SELECT * FROM sync_cursors WHERE source=$1',[source]);
    if(prior.rowCount){this.sourceStatus[source]={source,status:'connected',last_sync_at:prior.rows[0].last_sync_at,cursor:Number(prior.rows[0].last_event_id),error:null};return;}
    this.sourceStatus[source]={source,status:'importing',last_sync_at:null,error:null};
    if(!this.initialMessages)throw new Error('Configure the hospital initial-load adapter before synchronization');
    const snapshot=this.initialMessages(source);
    for(const message of snapshot.messages)await receiveFhir(this,source,message);
    await this.pool.query('INSERT INTO sync_cursors(source,last_event_id) VALUES($1,$2) ON CONFLICT(source) DO NOTHING',[source,snapshot.cursor]);
    this.sourceStatus[source]={source,status:'connected',last_sync_at:new Date().toISOString(),cursor:snapshot.cursor,error:null};
    console.log(`${source} initial FHIR load completed at event ${snapshot.cursor}`);
  }
  async syncSource(source:SourceName){
    const cursorResult=await this.pool.query('SELECT last_event_id FROM sync_cursors WHERE source=$1',[source]);
    if(!cursorResult.rowCount){await this.bootstrap(source);return 0;}
    const cursor=Number(cursorResult.rows[0].last_event_id);
    const response=await fetch(`http://127.0.0.1:${ports[source]}/fhir/changes?after=${cursor}&limit=500`,{headers:sourceHeaders(),signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const data=await response.json() as Row;
    let applied=0;
    for(const message of data.messages)applied+=(await receiveFhir(this,source,message)).applied;
    // Push does not advance the catch-up watermark. It can arrive out of order;
    // this ordered, replay-safe path accounts for every event before advancing.
    await this.pool.query('UPDATE sync_cursors SET last_event_id=$2,last_sync_at=now() WHERE source=$1',[source,data.next_cursor]);
    this.sourceStatus[source]={source,status:'connected',last_sync_at:new Date().toISOString(),cursor:Number(data.next_cursor),error:null};
    return applied;
  }
  async sync(){
    if(this.syncing)return;this.syncing=true;
    try{for(const source of sourceNames){try{await this.syncSource(source);}catch(e){this.sourceStatus[source]={...this.sourceStatus[source],status:'offline',error:(e as Error).message};}}}
    finally{this.syncing=false;}
  }
  async records(source:SourceName,name:string,query:Row={}){
    const table=tables.find(t=>t.source===source&&t.name===name);if(!table)throw new AppError(404,'Unknown table');
    const where:string[]=[],values:any[]=[],limit=Math.min(Math.max(Math.trunc(Number(query.limit)||25),1),1000),offset=Math.max(Math.trunc(Number(query.offset)||0),0);
    const bind=(v:any)=>{values.push(v);return '$'+values.length;};
    if(query.q){const p=bind('%'+String(query.q).replace(/[\\%_]/g,'\\$&')+'%');where.push(`(${table.search.map(f=>`${f} ILIKE ${p} ESCAPE '\\'`).join(' OR ')})`);}
    for(const [input,v]of Object.entries(query)){
      const field=({ward:'ward_code',from:'sample_date',to:'sample_date'} as Row)[input]||input;
      if(v===undefined||v===''||!fieldNames(table).includes(field))continue;
      where.push(`${field}${input==='from'?'>=':input==='to'?'<=':'='}${bind(v)}`);
    }
    const clause=where.length?' WHERE '+where.join(' AND '):'',relation=sqlTable(table);
    const total=(await this.pool.query(`SELECT count(*)::integer AS n FROM ${relation}${clause}`,values)).rows[0].n;
    const order=query.sort==='recent'?`created_at DESC NULLS LAST,${table.keys.join(',')}`:name==='cultures'?'sample_date DESC,culture_id':table.keys.join(',');
    const rows=(await this.pool.query(`SELECT * FROM ${relation}${clause} ORDER BY ${order} LIMIT ${bind(limit)} OFFSET ${bind(offset)}`,values)).rows;
    return {rows,total,limit,offset};
  }
  async record(source:SourceName,name:string,key:string):Promise<Row>{
    const table=tables.find(t=>t.source===source&&t.name===name);if(!table)throw new AppError(404,'Unknown table');
    const values=key.split('~');if(values.length!==table.keys.length)throw new AppError(400,'Record key does not match table key');
    const row=(await this.pool.query(`SELECT * FROM ${sqlTable(table)} WHERE ${table.keys.map((f,i)=>`${f}=$${i+1}`).join(' AND ')}`,values)).rows[0];
    if(!row)throw new AppError(404,'Record not found');
    if(name==='cultures'){
      row.isolates=(await this.pool.query('SELECT * FROM lis.isolates WHERE culture_id=$1 ORDER BY isolate_no',[key])).rows;
      const tests=(await this.pool.query('SELECT a.* FROM lis.ast_results a JOIN lis.isolates i USING(isolate_id) WHERE i.culture_id=$1',[key])).rows;
      for(const isolate of row.isolates)isolate.ast_results=tests.filter(a=>a.isolate_id===isolate.isolate_id);
    }
    return row;
  }
  async overview(){
    const totals=(await this.pool.query(`SELECT
      (SELECT count(*)::integer FROM adt.patients) AS patients,
      (SELECT count(*)::integer FROM adt.wards) AS wards,
      (SELECT count(*)::integer FROM lis.cultures) AS cultures,
      (SELECT count(*)::integer FROM lis.isolates) AS isolates,
      (SELECT count(*)::integer FROM lis.ast_results) AS tests,
      (SELECT count(*)::integer FROM lis.cultures WHERE status<>'final') AS pending,
      (SELECT max(sample_date) FROM lis.cultures) AS latest_sample,
      (SELECT min(sample_date) FROM lis.cultures) AS earliest_sample,
      (SELECT count(*)::integer FROM lis.cultures c LEFT JOIN adt.patients p USING(patient_id) LEFT JOIN adt.wards w USING(ward_code) WHERE p.patient_id IS NULL OR w.ward_code IS NULL) AS unresolved_cultures`)).rows[0];
    const [wards,weekly,specimens,organisms]=await Promise.all([
      this.pool.query(`SELECT w.*,count(c.culture_id)::integer AS cultures,count(c.culture_id) FILTER(WHERE c.result='positive')::integer AS positive,count(c.culture_id) FILTER(WHERE c.status<>'final')::integer AS pending FROM adt.wards w LEFT JOIN lis.cultures c USING(ward_code) GROUP BY w.ward_code ORDER BY cultures DESC`),
      this.pool.query(`WITH samples AS (
        SELECT date_trunc('week',sample_date::date)::date::text AS week,count(*)::integer AS cultures,
        count(DISTINCT patient_id)::integer AS patients,count(*) FILTER(WHERE result='positive')::integer AS positive
        FROM lis.cultures WHERE sample_date::date >= (SELECT max(sample_date)::date-interval '15 weeks' FROM lis.cultures) GROUP BY 1
      ), tests AS (
        SELECT date_trunc('week',c.sample_date::date)::date::text AS week,count(*)::integer AS tests
        FROM lis.ast_results a JOIN lis.isolates i USING(isolate_id) JOIN lis.cultures c USING(culture_id)
        WHERE c.sample_date::date >= (SELECT max(sample_date)::date-interval '15 weeks' FROM lis.cultures) GROUP BY 1
      ) SELECT s.*,coalesce(t.tests,0)::integer AS tests FROM samples s LEFT JOIN tests t USING(week) ORDER BY s.week`),
      this.pool.query('SELECT specimen,count(*)::integer AS count FROM lis.cultures GROUP BY specimen ORDER BY count DESC'),
      this.pool.query('SELECT organism,count(*)::integer AS count FROM lis.isolates GROUP BY organism ORDER BY count DESC LIMIT 5')
    ]);
    return {totals,wards:wards.rows,weekly:weekly.rows,specimens:specimens.rows,organisms:organisms.rows,sources:Object.values(this.sourceStatus),scope:'Historical supplied dataset; source synchronization is live. Reporting dates are selectable.'};
  }
  async patients(query:Row={}){
    const values:any[]=[],where:string[]=[];
    if(query.q){values.push(`%${String(query.q).replace(/[\\%_]/g,'\\$&')}%`);where.push(`(p.patient_id ILIKE $${values.length} ESCAPE '\\' OR p.home_area ILIKE $${values.length} ESCAPE '\\')`);}
    if(query.sex && ['F','M'].includes(query.sex)){values.push(query.sex);where.push(`p.sex=$${values.length}`);}
    if(query.has_samples==='yes')where.push('coalesce(c.sample_count,0)>0');
    if(query.has_samples==='no')where.push('coalesce(c.sample_count,0)=0');
    const limit=Math.min(Math.max(Math.trunc(Number(query.limit)||20),1),100),offset=Math.max(Math.trunc(Number(query.offset)||0),0);
    const cte=`WITH culture_counts AS (
      SELECT patient_id,count(*)::integer AS sample_count,max(sample_date) AS latest_sample,
        count(*) FILTER(WHERE result='positive')::integer AS positive_count,
        count(*) FILTER(WHERE status<>'final')::integer AS pending_count
      FROM lis.cultures GROUP BY patient_id
    ), isolate_counts AS (
      SELECT c.patient_id,count(i.isolate_id)::integer AS isolate_count FROM lis.isolates i JOIN lis.cultures c USING(culture_id) GROUP BY c.patient_id
    )`;
    const clause=where.length?'WHERE '+where.join(' AND '):'';
    const total=(await this.pool.query(`${cte} SELECT count(*)::integer AS n FROM adt.patients p LEFT JOIN culture_counts c USING(patient_id) ${clause}`,values)).rows[0].n;
    const rows=(await this.pool.query(`${cte} SELECT p.*,coalesce(c.sample_count,0)::integer AS sample_count,
      coalesce(c.positive_count,0)::integer AS positive_count,coalesce(c.pending_count,0)::integer AS pending_count,
      coalesce(i.isolate_count,0)::integer AS isolate_count,c.latest_sample
      FROM adt.patients p LEFT JOIN culture_counts c USING(patient_id) LEFT JOIN isolate_counts i USING(patient_id)
      ${clause} ORDER BY ${query.sort==='recent'?'p.created_at DESC NULLS LAST,p.patient_id DESC':'p.patient_id'} LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,limit,offset])).rows;
    const summary=(await this.pool.query(`SELECT count(*)::integer AS total,
      count(*) FILTER(WHERE EXISTS(SELECT 1 FROM lis.cultures c WHERE c.patient_id=p.patient_id))::integer AS with_samples,
      count(*) FILTER(WHERE EXISTS(SELECT 1 FROM lis.cultures c WHERE c.patient_id=p.patient_id AND c.status<>'final'))::integer AS with_pending
      FROM adt.patients p`)).rows[0];
    return {rows,total,limit,offset,summary};
  }
  async patientHistory(id:string){
    const patient=(await this.pool.query('SELECT * FROM adt.patients WHERE patient_id=$1',[id])).rows[0];
    if(!patient)return null;
    const [cultures,isolates,ast,stays]=await Promise.all([
      this.pool.query('SELECT * FROM fact_culture WHERE patient_id=$1 ORDER BY sample_date DESC,culture_id DESC',[id]),
      this.pool.query('SELECT * FROM fact_isolate WHERE patient_id=$1 ORDER BY sample_date DESC,isolate_id',[id]),
      this.pool.query('SELECT * FROM fact_ast WHERE patient_id=$1 ORDER BY sample_date DESC,isolate_id,antibiotic_code',[id]),
      this.pool.query('SELECT s.*,w.ward_en FROM adt.ward_stays s LEFT JOIN adt.wards w USING(ward_code) WHERE patient_id=$1 ORDER BY admission_date DESC',[id])
    ]);
    return {patient,cultures:cultures.rows.map(c=>({...c,isolates:isolates.rows.filter(i=>i.culture_id===c.culture_id).map(i=>({...i,ast_results:ast.rows.filter(a=>a.isolate_id===i.isolate_id)}))})),
      stays:stays.rows,summary:{samples:cultures.rows.length,isolates:isolates.rows.length,tests:ast.rows.length,pending:cultures.rows.filter(c=>c.status!=='final').length}};
  }
  async antibiogram(query:Row){
    const maxDate=(await this.pool.query('SELECT max(sample_date) AS d FROM lis.cultures')).rows[0].d;
    const to=query.to||maxDate;
    const from=query.from||new Date(new Date(`${to}T00:00:00Z`).getTime()-27*86400000).toISOString().slice(0,10);
    const values:any[]=[from,to];const filters=['c.sample_date >= $1','c.sample_date <= $2',"c.status='final'"];
    for(const [input,column] of [['ward','ward_code'],['organism','organism'],['specimen','specimen']] as const)if(query[input]){values.push(query[input]);filters.push(`${column==='organism'?'i':'c'}.${column}=$${values.length}`);}
    // First isolate is selected before joining antibiotic tests. Ward selection is
    // applied first; first-isolate selection is within the requested ward scope.
    const result=await this.pool.query(`WITH first_isolates AS (
      SELECT DISTINCT ON(c.patient_id,i.organism,c.specimen) i.isolate_id,i.organism,c.specimen
      FROM lis.isolates i JOIN lis.cultures c USING(culture_id)
      WHERE ${filters.join(' AND ')} ORDER BY c.patient_id,i.organism,c.specimen,c.sample_date,c.culture_id,i.isolate_no,i.isolate_id
    ) SELECT f.organism,f.specimen,a.antibiotic_code,ab.antibiotic,count(*)::integer AS tested,
      count(*) FILTER(WHERE a.result='R')::integer AS resistant,
      CASE WHEN count(*)>=30 THEN round(100.0*count(*) FILTER(WHERE a.result='R')/count(*),1) ELSE NULL END AS resistance_pct
      FROM first_isolates f JOIN lis.ast_results a USING(isolate_id) LEFT JOIN formulary.antibiotics ab USING(antibiotic_code)
      GROUP BY f.organism,f.specimen,a.antibiotic_code,ab.antibiotic ORDER BY tested DESC,f.organism,ab.antibiotic LIMIT 250`,values);
    return {from,to,rows:result.rows,minimum_isolates:30,deduplication:'First isolate per patient, organism and specimen type within selected dates and ward scope. Denominator: selected isolates tested against each antibiotic.'};
  }
}
