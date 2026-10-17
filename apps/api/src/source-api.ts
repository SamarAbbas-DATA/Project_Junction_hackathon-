import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import { createHash } from 'node:crypto';
import { AppError, ports, sourceToken, type SourceName } from './config.js';
import { keyOf, recordSchema, type Table } from './catalog.js';
import { SourceStore, type Row } from './source-store.js';
import { fhirChanges } from './fhir-source.js';

const aliases:Record<string,string>={ast:'ast_results','ast-results':'ast_results','susceptibility-results':'ast_results','specimen-types':'specimen_types','ward-stays':'ward_stays'};
export const resolveTable=(name:string)=>aliases[name]||name;
export function normalize(table:Table, input:Row) {
  const row={...input};
  for(const field of table.fields){
    if(typeof row[field.name]==='string')row[field.name]=row[field.name].trim();
    if(field.date && row[field.name]){
      const date=new Date(row[field.name]+'T00:00:00Z');
      if(!/^\d{4}-\d{2}-\d{2}$/.test(row[field.name]) || !Number.isFinite(date.valueOf()) || date.toISOString().slice(0,10)!==row[field.name])throw new AppError(400,`${field.name} must be a valid YYYY-MM-DD date`);
    }
    if(field.required && row[field.name]==='')throw new AppError(400,`${field.name} cannot be blank`);
  }
  for(const key of table.keys)if(String(row[key]??'').includes('~'))throw new AppError(400,'Identifiers cannot contain ~');
  return row;
}
async function remote(source:SourceName,table:string,id:string) {
  const result=await fetch(`http://127.0.0.1:${ports[source]}/${table}/${encodeURIComponent(id)}`,{headers:sourceToken?{'x-api-key':sourceToken}:{},signal:AbortSignal.timeout(5000)}).catch(()=>{throw new AppError(503,`${source} source is unavailable; no record was saved`);});
  if(result.status===404)throw new AppError(422,`${table}: referenced record ${id} does not exist`);
  if(!result.ok)throw new AppError(503,`${source} source could not validate the reference`);
  return result.json() as Promise<Row>;
}
export async function validateRecord(store:SourceStore,table:Table,row:Row) {
  if(table.name==='ward_stays'){
    if(!store.get('patients',row.patient_id))throw new AppError(422,'Patient does not exist');
    const ward=store.get('wards',row.ward_code);if(!ward || ward.ward_type!=='in')throw new AppError(422,'Ward stay requires an inpatient ward');
  }
  if(table.name==='cultures'){
    const [patient,ward]=await Promise.all([remote('adt','patients',row.patient_id),remote('adt','wards',row.ward_code)]);
    if(!store.get('specimen_types',row.specimen))throw new AppError(422,'Specimen type does not exist');
    if(ward.ward_type==='in'&&!row.admission_date)throw new AppError(422,'Inpatient sample requires admission_date');
    if(ward.ward_type==='out'&&row.admission_date)throw new AppError(422,'Outpatient sample must not have an inpatient admission date');
    if(row.admission_date && row.admission_date>row.sample_date)throw new AppError(422,'Admission date cannot follow sample date');
    if(Math.abs(Number(row.sample_date.slice(0,4))-patient.birth_year-row.age_years)>1)throw new AppError(422,'Age is inconsistent with patient birth year and sample date');
    if(row.status==='final'&&!row.result)throw new AppError(422,'Final culture requires a culture result');
    const currentCount=(store.db.prepare('SELECT count(*) AS n FROM isolates WHERE culture_id=?').get(row.culture_id) as Row).n;
    if(row.n_isolates!==undefined&&row.n_isolates!==currentCount)throw new AppError(422,`n_isolates is maintained from isolate records; current count is ${currentCount}`);
    if(row.result && row.result!=='positive' && currentCount>0)throw new AppError(422,'A culture with isolates cannot be negative or mixed_growth');
  }
  if(table.name==='isolates'){
    const culture=store.get('cultures',row.culture_id);if(!culture)throw new AppError(422,'Culture does not exist');
    if(['negative','mixed_growth'].includes(culture.result))throw new AppError(422,'Cannot attach an isolate to a negative or mixed-growth culture');
  }
  if(table.name==='ast_results'){
    const isolate=store.get('isolates',row.isolate_id);if(!isolate)throw new AppError(422,'Isolate does not exist');
    const culture=store.get('cultures',isolate.culture_id)!;
    const [antibiotic]=await Promise.all([remote('formulary','antibiotics',row.antibiotic_code),remote('formulary','guidelines',row.guideline)]);
    if(antibiotic.reported_for==='urine'&&culture.specimen!=='urine')throw new AppError(422,'This antibiotic is reported for urine specimens only');
  }
}
export async function createSourceApi(store:SourceStore) {
  const app=Fastify({logger:false,ajv:{customOptions:{removeAdditional:false}}});
  await app.register(cors,{origin:['http://127.0.0.1:5173','http://localhost:5173']});
  await app.register(swagger,{openapi:{info:{title:`AMR ${store.source.toUpperCase()} source API`,version:'1.0.0'}}});
  await app.register(swaggerUI,{routePrefix:'/docs'});
  app.addHook('onRequest',async request=>{if(sourceToken && request.url!=='/health' && !request.url.startsWith('/docs') && request.headers['x-api-key']!==sourceToken)throw new AppError(401,'Source API key required');});
  app.setErrorHandler((error,request,reply)=>{
    const e=error as any;
    const code=e.statusCode || (e.code?.startsWith('ERR_SQLITE') ? (/UNIQUE|PRIMARY KEY/.test(e.message)?409:422):500);
    if(code>=500)console.error(`[${store.source}]`,e.message);
    reply.code(code).send({error:code>=500?'Source request failed':e.message,details:e.validation||undefined});
  });
  app.get('/health',async()=>({status:'ok',source:store.source,database:`${store.source}_db.sqlite`}));
  app.get('/schema',async()=>({source:store.source,tables:store.catalog}));
  app.get('/fhir/changes',async request=>{const q=request.query as Row;return fhirChanges(store,Number(q.after||0),Number(q.limit||100));});
  if(store.source==='adt')app.get('/patients/:id/stays',async request=>{const {id}=request.params as Row;return store.list('ward_stays',{patient_id:id,limit:1000});});
  for(const table of store.catalog){
    const routes=[table.name,...Object.keys(aliases).filter(k=>aliases[k]===table.name)];
    for(const route of routes){
      app.get(`/${route}`,async request=>store.list(table.name,request.query as Row));
      app.get(`/${route}/:id`,async request=>{
        const {id}=request.params as Row;const row=store.get(table.name,id);if(!row)throw new AppError(404,'Record not found');
        if(table.name==='cultures'){
          const isolates=store.list('isolates',{culture_id:id,limit:1000}).rows as Row[];
          return {...row,isolates:isolates.map(i=>({...i,ast_results:store.list('ast_results',{isolate_id:i.isolate_id,limit:1000}).rows}))};
        }return row;
      });
      app.post(`/${route}`,{schema:{body:recordSchema(table)}},async(request,reply)=>{
        const row=normalize(table,request.body as Row);
        if(table.name==='cultures'){row.n_isolates??=0;row.result??=null;row.admission_date??=null;}
        if(table.name==='isolates')for(const flag of ['esbl','mrsa','vre','cpe'])row[flag]??=0;
        if(table.name==='ward_stays')row.origin??='recorded';
        const requestKey=request.headers['idempotency-key'] as string|undefined;
        const hash=createHash('sha256').update(JSON.stringify(row)).digest('hex');
        if(requestKey){
          const prior=store.db.prepare('SELECT * FROM request_keys WHERE request_key=?').get(requestKey) as Row|undefined;
          if(prior){if(prior.body_hash!==hash||prior.table_name!==table.name)throw new AppError(409,'Idempotency key was already used for a different request');return reply.code(200).send(store.get(prior.table_name,prior.record_key));}
        }
        await validateRecord(store,table,row);
        const saved=store.transaction(()=>{
          const saved=store.insert(table.name,row);
          if(table.name==='isolates'){
            const c=store.get('cultures',row.culture_id)!;
            const n=(store.db.prepare('SELECT count(*) AS n FROM isolates WHERE culture_id=?').get(row.culture_id) as Row).n;
            store.update('cultures',row.culture_id,{n_isolates:n,result:'positive',status:c.status==='registered'?'preliminary':c.status});
          }
          if(requestKey)store.db.prepare('INSERT INTO request_keys VALUES(?,?,?,?)').run(requestKey,table.name,keyOf(table,row),hash);
          return saved;
        });
        return reply.code(201).send(saved);
      });
      app.patch(`/${route}/:id`,{schema:{body:recordSchema(table,true)}},async request=>{
        const {id}=request.params as Row,current=store.get(table.name,id);if(!current)throw new AppError(404,'Record not found');
        const version=request.headers['if-match'];if(!version||!/^\d+$/.test(String(version)))throw new AppError(428,'Supply current record_version in the If-Match header');
        const patch=normalize(table,request.body as Row);
        if(table.name==='isolates' && (patch.culture_id!==undefined&&patch.culture_id!==current.culture_id))throw new AppError(400,'An existing isolate cannot be moved to another culture');
        await validateRecord(store,table,{...current,...patch});
        return store.transaction(()=>store.update(table.name,id,patch,Number(version)));
      });
    }
  }
  return app;
}
