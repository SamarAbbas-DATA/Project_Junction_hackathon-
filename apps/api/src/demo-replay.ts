import fs from 'node:fs';
import path from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { tables,keyOf } from './catalog.js';
import { sourceNames } from './config.js';
import { readDemoZip,type ImportReceipt } from './demo-import.js';
import type { SourceStore,Row } from './source-store.js';

const patientTables=['ast_results','isolates','cultures','ward_stays','patients'];
const pendingKey='demo_replay_pending';
type Entry={table:string;row:Row};
type Plan={receipts:string[];records:Entry[];patients:number;protected_patients:number};
const canonical=(id:string)=>id.replace(/^DEMO-/,'BATCH-');
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const tag=(table:string,key:string)=>`${table}:${key}`;

function finishReset(stores:Record<string,SourceStore>,directory:string,receiptDirectory:string,backup:string,plan:Plan){
  const db=stores.adt.db;
  db.prepare('ATTACH DATABASE ? AS replay_lis').run(path.join(directory,'lis_db.sqlite'));
  let transaction=false;
  try{
    db.exec('BEGIN IMMEDIATE');transaction=true;
    // Child-first deletes produce the normal source outbox tombstones. Neither
    // reference tables nor original seed rows are part of this allowlist.
    for(const name of patientTables){
      const table=tables.find(t=>t.name===name)!,schema=table.source==='adt'?'main':'replay_lis';
      const remove=db.prepare(`DELETE FROM ${schema}.${name} WHERE ${table.keys.map(k=>`${k}=?`).join(' AND ')}`);
      const forget=db.prepare(`DELETE FROM ${schema}.request_keys WHERE table_name=? AND record_key=?`);
      for(const entry of plan.records.filter(r=>r.table===name)){
        remove.run(...table.keys.map(k=>entry.row[k]));
        // A replay must insert again, rather than returning a stale idempotency
        // response for the former, now-deleted source record.
        forget.run(name,keyOf(table,entry.row));
      }
    }
    for(const schema of ['main','replay_lis'])if(db.prepare(`PRAGMA ${schema}.foreign_key_check`).all().length)throw new Error('Demo replay would leave invalid source references');
    db.exec('COMMIT');transaction=false;
  }catch(error){if(transaction)db.exec('ROLLBACK');throw error;}
  finally{db.exec('DETACH DATABASE replay_lis');}
  for(const hash of plan.receipts){
    if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('Invalid replay receipt hash');
    const file=path.join(receiptDirectory,hash+'.json');if(!fs.existsSync(file))continue;
    const previous=JSON.parse(fs.readFileSync(file,'utf8')) as ImportReceipt;
    const fresh:ImportReceipt={file:previous.file,hash,batch_id:previous.batch_id,status:'queued',created:0,reused:0,finalized:0,updated_at:new Date().toISOString()};
    fs.writeFileSync(file+'.tmp',JSON.stringify(fresh,null,2)+'\n');fs.renameSync(file+'.tmp',file);
  }
  db.prepare('DELETE FROM import_metadata WHERE key=?').run(pendingKey);
  return {reset:true,patients:plan.patients,protected_patients:plan.protected_patients,records:plan.records.length,backup,reason:'completed'};
}

// Only called once at backend startup, before opening the source APIs. An
// incomplete cycle resumes normally; it is never cleared at a polling tick.
export function replayCompletedDemo(stores:Record<string,SourceStore>,directory:string,inbox:string,receiptDirectory=path.join(directory,'demo-imports')){
  const none=(reason:string)=>({reset:false,patients:0,protected_patients:0,records:0,backup:null as string|null,reason});
  const pending=stores.adt.db.prepare('SELECT value FROM import_metadata WHERE key=?').get(pendingKey) as Row|undefined;
  if(pending){
    const marker=JSON.parse(pending.value),relative=path.relative(path.join(directory,'demo-replays'),marker.backup);
    if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Invalid demo replay recovery directory');
    const bytes=fs.readFileSync(path.join(marker.backup,'plan.json'));if(digest(bytes)!==marker.hash)throw new Error('Demo replay recovery plan changed');
    const plan=JSON.parse(bytes.toString('utf8')) as Plan;
    if(plan.records.some(r=>!patientTables.includes(r.table)))throw new Error('Invalid demo replay record type');
    return finishReset(stores,directory,receiptDirectory,marker.backup,plan);
  }
  if(!fs.existsSync(inbox))return none('empty');
  const files=fs.readdirSync(inbox).filter(f=>f.toLowerCase().endsWith('.zip')).sort();if(!files.length)return none('empty');
  const batches=[] as ReturnType<typeof readDemoZip>[];
  for(const name of files){
    try{
      const file=path.join(inbox,name);if(!fs.statSync(file).isFile()||fs.statSync(file).size>50*1024*1024)return none('unreadable batch');
      const bytes=fs.readFileSync(file),batch=readDemoZip(bytes),receiptFile=path.join(receiptDirectory,digest(bytes)+'.json');
      if(!fs.existsSync(receiptFile))return none('unfinished batch');
      const receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8')) as ImportReceipt;
      if(receipt.status!=='completed'||receipt.hash!==digest(bytes)||canonical(receipt.batch_id)!==canonical(batch.batch_id))return none('unfinished batch');
      batches.push(batch);
    }catch{return none('unreadable batch or receipt');}
  }
  const allowed=new Set<string>(),patientIds=new Set<string>(),batchIds=new Set(batches.map(b=>canonical(b.batch_id)));
  for(const batch of batches){
    const ids=[canonical(batch.batch_id),batch.batch_id.replace(/^BATCH-/,'DEMO-')],prefixes=ids.map(id=>`csv-${id}-`);
    for(const name of patientTables){
      const table=tables.find(t=>t.name===name)!,store=stores[table.source];
      for(const row of batch.tables[name]){
        const key=keyOf(table,row);
        // Exact manifest keys plus the importer-created idempotency record are
        // required. An ID's prefix or numeric range is never deletion authority.
        const owners=store.db.prepare('SELECT request_key FROM request_keys WHERE table_name=? AND record_key=?').all(name,key) as Row[];
        if(owners.some(owner=>prefixes.some(prefix=>owner.request_key.startsWith(prefix)))){
          allowed.add(tag(name,key));if(name==='patients')patientIds.add(row.patient_id);
        }
      }
    }
  }
  const records:Entry[]=[],seen=new Set<string>();let patients=0,protectedPatients=0;
  for(const id of patientIds){
    const patient=stores.adt.get('patients',id);if(!patient)continue;
    const current:Record<string,Row[]>={patients:[patient],ward_stays:stores.adt.db.prepare('SELECT * FROM ward_stays WHERE patient_id=?').all(id) as Row[],cultures:stores.lis.db.prepare('SELECT * FROM cultures WHERE patient_id=?').all(id) as Row[],isolates:stores.lis.db.prepare('SELECT i.* FROM isolates i JOIN cultures c USING(culture_id) WHERE c.patient_id=?').all(id) as Row[],ast_results:stores.lis.db.prepare('SELECT a.* FROM ast_results a JOIN isolates i USING(isolate_id) JOIN cultures c USING(culture_id) WHERE c.patient_id=?').all(id) as Row[]};
    if(patientTables.some(name=>current[name].some(row=>!allowed.has(tag(name,keyOf(tables.find(t=>t.name===name)!,row)))))){protectedPatients++;continue;}
    patients++;
    for(const name of patientTables)for(const row of current[name]){const key=tag(name,keyOf(tables.find(t=>t.name===name)!,row));if(!seen.has(key)){seen.add(key);records.push({table:name,row});}}
  }
  const receipts:string[]=[];
  for(const name of fs.readdirSync(receiptDirectory).filter(f=>/^[a-f0-9]{64}\.json$/.test(f))){
    const receipt=JSON.parse(fs.readFileSync(path.join(receiptDirectory,name),'utf8')) as ImportReceipt;
    if(batchIds.has(canonical(receipt.batch_id)))receipts.push(name.slice(0,-5));
  }
  const backup=path.join(directory,'demo-replays',new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));fs.mkdirSync(path.join(backup,'receipts'),{recursive:true});
  for(const source of sourceNames)stores[source].db.prepare('VACUUM INTO ?').run(path.join(backup,`${source}_db.sqlite`));
  for(const hash of receipts)fs.copyFileSync(path.join(receiptDirectory,hash+'.json'),path.join(backup,'receipts',hash+'.json'));
  const plan:Plan={receipts,records,patients,protected_patients:protectedPatients},json=JSON.stringify(plan,null,2)+'\n';fs.writeFileSync(path.join(backup,'plan.json'),json);
  // Persist before deleting anything. A crash between source deletion and
  // receipt updates resumes this same backed-up plan before serving requests.
  stores.adt.db.prepare('INSERT INTO import_metadata(key,value) VALUES(?,?)').run(pendingKey,JSON.stringify({backup,hash:digest(json)}));
  return finishReset(stores,directory,receiptDirectory,backup,plan);
}
