import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError, type SourceName } from './config.js';
import { tables, fieldNames, keyOf, type Table } from './catalog.js';

export type Row = Record<string, any>;
export class SourceStore {
  onChange:()=>void=()=>{};
  db: DatabaseSync;
  catalog: Table[];
  constructor(public source: SourceName, directory:string) {
    fs.mkdirSync(directory,{recursive:true});
    this.db = new DatabaseSync(path.join(directory,`${source}_db.sqlite`));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.catalog = tables.filter(t=>t.source===source);
    this.db.exec(`CREATE TABLE IF NOT EXISTS events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, record_key TEXT NOT NULL,
      operation TEXT NOT NULL, payload TEXT NOT NULL, occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ); CREATE INDEX IF NOT EXISTS idx_event_record ON events(entity,record_key,event_id DESC);
    CREATE TABLE IF NOT EXISTS fhir_outbox(event_id INTEGER PRIMARY KEY,bundle TEXT NOT NULL,FOREIGN KEY(event_id) REFERENCES events(event_id));
    CREATE TABLE IF NOT EXISTS import_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS request_keys (request_key TEXT PRIMARY KEY, table_name TEXT NOT NULL, record_key TEXT NOT NULL, body_hash TEXT NOT NULL);`);
    for (const table of this.catalog) {
      const columns = table.fields.map(f=>`${f.name} ${f.type ? 'INTEGER' : 'TEXT'}${f.required ? ' NOT NULL' : ''}${f.values ? ` CHECK (${f.name} IN (${f.values.map(v=>typeof v==='number' ? v : `'${v}'`).join(',')}))` : ''}`);
      const constraints = [`PRIMARY KEY (${table.keys.join(',')})`];
      if (table.name==='ward_stays') constraints.push('FOREIGN KEY(patient_id) REFERENCES patients(patient_id)','FOREIGN KEY(ward_code) REFERENCES wards(ward_code)','UNIQUE(patient_id,ward_code,admission_date)');
      if (table.name==='cultures') constraints.push('FOREIGN KEY(specimen) REFERENCES specimen_types(specimen)', 'CHECK(age_years BETWEEN 0 AND 120)', "CHECK(status IN ('registered','preliminary','final'))", "CHECK(status <> 'final' OR result IS NOT NULL)");
      if (table.name==='isolates') constraints.push('FOREIGN KEY(culture_id) REFERENCES cultures(culture_id)','UNIQUE(culture_id,isolate_no)');
      if (table.name==='ast_results') constraints.push('FOREIGN KEY(isolate_id) REFERENCES isolates(isolate_id)');
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${table.name} (${columns.join(',')},
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        record_version INTEGER NOT NULL DEFAULT 1, ${constraints.join(',')});`);
      for (const field of table.search) this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${table.name}_${field} ON ${table.name}(${field});`);
      for (const operation of ['INSERT','UPDATE','DELETE']) {
        const ref = operation==='DELETE' ? 'OLD' : 'NEW';
        const key = table.keys.map(k=>`${ref}.${k}`).join(" || '~' || ");
        const fields = [...fieldNames(table),'created_at','updated_at','record_version'];
        this.db.exec(`CREATE TRIGGER IF NOT EXISTS events_${table.name}_${operation} AFTER ${operation} ON ${table.name}
          BEGIN INSERT INTO events(entity,record_key,operation,payload) VALUES (
            '${table.name}',${key},'${operation.toLowerCase()}',json_object(${fields.map(f=>`'${f}',${ref}.${f}`).join(',')})); END;`);
      }
    }
    if(source==='lis') this.db.exec('CREATE INDEX IF NOT EXISTS idx_cultures_sample_date ON cultures(sample_date); CREATE INDEX IF NOT EXISTS idx_ast_antibiotic ON ast_results(antibiotic_code);');
  }
  table(name:string) { const table=this.catalog.find(t=>t.name===name); if(!table) throw new AppError(404,'Unknown source table'); return table; }
  get(name:string,key:string): Row | undefined {
    const table=this.table(name), values=key.split('~');
    if(values.length!==table.keys.length) throw new AppError(400,'Record key does not match table key');
    return this.db.prepare(`SELECT * FROM ${name} WHERE ${table.keys.map(k=>`${k}=?`).join(' AND ')}`).get(...values) as Row | undefined;
  }
  list(name:string,query:Row={}) {
    const table=this.table(name), where:string[]=[], params:any[]=[];
    const limit=Math.min(Math.max(Number(query.limit)||25,1),1000), offset=Math.max(Number(query.offset)||0,0);
    if(query.q) { where.push(`(${table.search.map(k=>`${k} LIKE ? ESCAPE '\\'`).join(' OR ')})`); const q=String(query.q).replace(/[\\%_]/g,'\\$&'); params.push(...table.search.map(()=>`%${q}%`)); }
    const aliases:Row={ward:'ward_code',from:'sample_date',to:'sample_date'};
    for(const [input,value] of Object.entries(query)) {
      const field=aliases[input]||input;
      if(value===undefined || value==='' || ['q','limit','offset'].includes(input) || !fieldNames(table).includes(field)) continue;
      where.push(`${field}${input==='from'?'>=':input==='to'?'<=':'='}?`);params.push(value);
    }
    const clause=where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const total=(this.db.prepare(`SELECT count(*) AS n FROM ${name}${clause}`).get(...params) as Row).n;
    const order=query.sort==='recent'?`created_at DESC,${table.keys.join(',')}`:name==='cultures'?'sample_date DESC,culture_id':table.keys.join(',');
    const rows=this.db.prepare(`SELECT * FROM ${name}${clause} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params,limit,offset);
    return {rows,total,limit,offset};
  }
  snapshot() {
    this.db.exec('BEGIN');
    try {
      const cursor=(this.db.prepare('SELECT coalesce(max(event_id),0) AS id FROM events').get() as Row).id;
      const data=Object.fromEntries(this.catalog.map(t=>[t.name,this.db.prepare(`SELECT * FROM ${t.name}`).all()]));
      this.db.exec('COMMIT'); return {source:this.source,cursor,tables:data};
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  events(since:number,limit=500) {
    if(!Number.isSafeInteger(since)||since<0)throw new AppError(400,'since must be a nonnegative event cursor');
    const rows=this.db.prepare('SELECT * FROM events WHERE event_id>? ORDER BY event_id LIMIT ?').all(since,Math.min(limit,1000)) as Row[];
    return {source:this.source,events:rows.map(r=>({...r,payload:JSON.parse(r.payload)})),next_cursor:rows.at(-1)?.event_id ?? since};
  }
  transaction<T>(fn:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try {const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  insert(name:string,record:Row) {
    const table=this.table(name), fields=fieldNames(table);
    this.db.prepare(`INSERT INTO ${name} (${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`).run(...fields.map(f=>record[f]??null));
    this.onChange();
    return this.get(name,keyOf(table,record))!;
  }
  update(name:string,key:string,patch:Row,expectedVersion?:number) {
    const table=this.table(name), current=this.get(name,key);
    if(!current)throw new AppError(404,'Record not found');
    if(expectedVersion!==undefined && current.record_version!==expectedVersion)throw new AppError(409,'Record changed since it was opened. Reload before saving.');
    if(table.keys.some(k=>patch[k]!==undefined && patch[k]!==current[k]))throw new AppError(400,'Primary identifiers cannot be changed');
    const fields=Object.keys(patch).filter(f=>!table.keys.includes(f));
    if(!fields.length)throw new AppError(400,'No editable fields supplied');
    const result=this.db.prepare(`UPDATE ${name} SET ${fields.map(f=>`${f}=?`).join(',')},updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),record_version=record_version+1 WHERE ${table.keys.map(k=>`${k}=?`).join(' AND ')} AND record_version=?`).run(...fields.map(f=>patch[f]??null),...table.keys.map(k=>current[k]),current.record_version);
    if(Number(result.changes)!==1)throw new AppError(409,'Concurrent update: reload the record');
    this.onChange();
    return this.get(name,key)!;
  }
  close(){this.db.close();}
}
