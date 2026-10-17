import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { AppError,sourceNames,sourceToken,type SourceName } from './config.js';
import { keyOf } from './catalog.js';
import { decodeMessage,type FhirChange } from './fhir-mapping.js';
import type { HubStore } from './hub-store.js';
import type { Row } from './source-store.js';
import { enqueueAnomalyWork } from './anomaly-store.js';

const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;

export async function initializeIntake(hub:HubStore){
  await hub.pool.query(`CREATE TABLE IF NOT EXISTS integration_inbox(
    source TEXT NOT NULL,message_id TEXT NOT NULL,bundle_hash TEXT NOT NULL,bundle JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',error TEXT,received_at TIMESTAMPTZ NOT NULL DEFAULT now(),processed_at TIMESTAMPTZ,
    PRIMARY KEY(source,message_id));
    CREATE INDEX IF NOT EXISTS idx_intake_status ON integration_inbox(status,received_at);
    CREATE TABLE IF NOT EXISTS fhir_resource_state(
    source TEXT NOT NULL,resource_type TEXT NOT NULL,resource_id TEXT NOT NULL,version BIGINT NOT NULL,
    deleted BOOLEAN NOT NULL DEFAULT false,resource JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(source,resource_type,resource_id));`);
}

async function affected(client:PoolClient,changes:FhirChange[]){
  const patients=new Set<string>(),cultures=new Set<string>(),wards=new Set<string>(),organisms=new Set<string>();
  const isolates=new Set<string>(),stays=new Set<string>();
  for(const {row}of changes){if(row.patient_id)patients.add(row.patient_id);if(row.culture_id)cultures.add(row.culture_id);if(row.ward_code)wards.add(row.ward_code);if(row.organism)organisms.add(row.organism);if(row.isolate_id)isolates.add(row.isolate_id);if(row.stay_id)stays.add(row.stay_id);}
  if(stays.size){const result=await client.query('SELECT patient_id,ward_code FROM adt.ward_stays WHERE stay_id=ANY($1::text[])',[[...stays]]);for(const r of result.rows){patients.add(r.patient_id);wards.add(r.ward_code);}}
  if(isolates.size){const result=await client.query('SELECT culture_id,organism FROM lis.isolates WHERE isolate_id=ANY($1::text[])',[[...isolates]]);for(const r of result.rows){cultures.add(r.culture_id);organisms.add(r.organism);}}
  if(cultures.size){const result=await client.query('SELECT patient_id,ward_code FROM lis.cultures WHERE culture_id=ANY($1::text[])',[[...cultures]]);for(const r of result.rows){patients.add(r.patient_id);wards.add(r.ward_code);}}
  return {tables:[...new Set(changes.map(c=>c.table.name))],patient_ids:[...patients],culture_ids:[...cultures],isolate_ids:[...isolates],ward_codes:[...wards],organisms:[...organisms]};
}

export async function receiveFhir(hub:HubStore,source:SourceName,bundle:Row){
  // Save before validating the clinical payload. Failures are inspectable and
  // can be replayed after fixing a converter; they never partially apply.
  const id=bundle?.identifier?.value;
  if(typeof id!=='string'||!id||id.length>200)throw new AppError(422,'A message identifier is required');
  const bytes=JSON.stringify(canonical(bundle)),hash=createHash('sha256').update(bytes).digest('hex');
  await hub.pool.query('INSERT INTO integration_inbox(source,message_id,bundle_hash,bundle) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[source,id,hash,bundle]);
  const client=await hub.pool.connect();let applied=0,scope:Row|undefined;
  try{
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['amr-fhir-'+source]);
    const saved=(await client.query('SELECT * FROM integration_inbox WHERE source=$1 AND message_id=$2 FOR UPDATE',[source,id])).rows[0];
    if(saved.bundle_hash!==hash)throw new AppError(409,'Message ID was already used with different content');
    if(saved.status==='applied'){await client.query('COMMIT');return {message_id:id,status:'applied',applied:0,duplicate:true};}
    let message:ReturnType<typeof decodeMessage>;
    try{message=decodeMessage(source,bundle);}catch(error){if(error instanceof AppError)throw error;throw new AppError(422,'Malformed resource in FHIR message');}
    const states=await client.query(`SELECT s.resource_type,s.resource_id,s.version FROM fhir_resource_state s
      JOIN jsonb_to_recordset($2::jsonb) AS r(resource_type TEXT,resource_id TEXT) USING(resource_type,resource_id) WHERE s.source=$1`,[source,JSON.stringify(message.changes.map(c=>({resource_type:c.resource.resourceType,resource_id:c.resource.id})))]);
    const versions=new Map(states.rows.map(r=>[r.resource_type+'/'+r.resource_id,Number(r.version)]));
    const changes=message.changes.filter(c=>c.version>(versions.get(c.resource.resourceType+'/'+c.resource.id)??-1));
    // Include the previous ward/organism scope when a correction moves a record.
    scope=await affected(client,changes);
    for(const name of [...new Set(changes.map(c=>c.table.name))]){
      const group=changes.filter(c=>c.table.name===name),table=group[0].table;
      for(const c of group.filter(c=>c.deleted))await client.query(`DELETE FROM ${source}.${name} WHERE ${table.keys.map((key,i)=>`${key}=$${i+1}`).join(' AND ')}`,table.keys.map(key=>c.row[key]));
      await hub.upsert(client,table,group.filter(c=>!c.deleted).map(c=>c.row));
    }
    if(changes.length){
      await client.query(`INSERT INTO fhir_resource_state(source,resource_type,resource_id,version,deleted,resource)
        SELECT $1,r.resource_type,r.resource_id,r.version,r.deleted,r.resource FROM jsonb_to_recordset($2::jsonb)
        AS r(resource_type TEXT,resource_id TEXT,version BIGINT,deleted BOOLEAN,resource JSONB)
        ON CONFLICT(source,resource_type,resource_id) DO UPDATE SET version=excluded.version,deleted=excluded.deleted,resource=excluded.resource,updated_at=now()`,[source,JSON.stringify(changes.map(c=>({resource_type:c.resource.resourceType,resource_id:c.resource.id,version:c.version,deleted:c.deleted,resource:c.resource})))]);
      const after=await affected(client,changes);for(const field of ['tables','patient_ids','culture_ids','isolate_ids','ward_codes','organisms'] as const)scope[field]=[...new Set([...scope[field],...after[field]])];
      await enqueueAnomalyWork(client,scope,source);
      // Existing activity consumers keep their compact clinical event history.
      if(!message.bootstrap){const focus=message.changes.find(c=>bundle.entry[0].resource.focus?.[0]?.reference===`${c.resource.resourceType}/${c.resource.id}`)||changes[0];
        await client.query(`INSERT INTO event_log(source,source_event_id,entity,record_key,operation,payload,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[source,message.sequence,focus.table.name,keyOf(focus.table,focus.row),focus.deleted?'delete':'upsert',focus.row,bundle.timestamp]);}
      applied=changes.length;
    }
    await client.query("UPDATE integration_inbox SET status='applied',error=NULL,processed_at=now() WHERE source=$1 AND message_id=$2",[source,id]);
    await client.query('COMMIT');
  }catch(error){
    await client.query('ROLLBACK');
    await client.query("UPDATE integration_inbox SET status='rejected',error=$3 WHERE source=$1 AND message_id=$2 AND status<>'applied'",[source,id,(error as Error).message]);
    await enqueueAnomalyWork(client,{});throw error;
  }finally{client.release();}
  if(applied)hub.onChange({type:'source.updated',source,count:applied,protocol:'FHIR R4',affected:scope});
  return {message_id:id,status:'applied',applied,duplicate:false};
}

export function registerFhirIntake(app:FastifyInstance,hub:HubStore){
  app.addContentTypeParser('application/fhir+json',{parseAs:'string'},(_request,body,done)=>{try{done(null,JSON.parse(body as string));}catch{done(new AppError(400,'Invalid FHIR JSON'),undefined);}});
  const guard=(request:any)=>{if(sourceToken&&request.headers['x-api-key']!==sourceToken)throw new AppError(401,'Source API key required');const source=request.params.source;if(!sourceNames.includes(source))throw new AppError(404,'Unknown source');return source as SourceName;};
  app.post('/api/intake/fhir/:source',async request=>receiveFhir(hub,guard(request),request.body as Row));
  app.post('/api/intake/fhir/:source/:id/replay',async request=>{
    const source=guard(request),id=(request.params as Row).id;
    const saved=(await hub.pool.query('SELECT bundle FROM integration_inbox WHERE source=$1 AND message_id=$2',[source,id])).rows[0];
    if(!saved)throw new AppError(404,'Inbox message not found');return receiveFhir(hub,source,saved.bundle);
  });
  app.get('/api/intake/status',async()=>({protocol:'FHIR R4',messages:(await hub.pool.query('SELECT source,status,count(*)::integer AS count FROM integration_inbox GROUP BY source,status ORDER BY source,status')).rows}));
}
