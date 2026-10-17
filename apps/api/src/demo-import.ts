import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';
import { tables, fieldNames, keyOf, type Table } from './catalog.js';
import { AppError, dataDir, ports, root, sourceToken } from './config.js';
import { importOrder, validateDemoBatch, type DemoBatch } from './demo-data.js';
import type { Row } from './source-store.js';
import { loadIdentifierMap,remapSyntheticRow } from './synthetic-identifiers.js';

export function readDemoZip(bytes: Buffer): DemoBatch {
  const zip=new AdmZip(bytes);
  if(zip.getEntries().reduce((sum,e)=>sum+e.header.size,0)>50*1024*1024) throw new AppError(400,'Uncompressed batch exceeds 50 MB');
  const manifest=zip.getEntry('manifest.json');
  if(!manifest) throw new AppError(400,'CSV batch requires manifest.json');
  const batch=JSON.parse(manifest.getData().toString('utf8')) as DemoBatch;
  batch.tables={};
  for(const table of tables) {
    const entry=zip.getEntry(table.name+'.csv');
    if(!entry) throw new AppError(400,`Missing ${table.name}.csv`);
    const fields=fieldNames(table);
    const rows=parse(entry.getData().toString('utf8'),{bom:true,skip_empty_lines:true,columns:(headers:string[])=>{
      if(headers.length!==fields.length || new Set(headers).size!==headers.length || fields.some(f=>!headers.includes(f))) throw new AppError(400,`${table.name}.csv must contain exactly these columns: ${fields.join(', ')}`);
      return headers;
    }}) as Record<string,string>[];
    batch.tables[table.name]=rows.map(row=>Object.fromEntries(table.fields.flatMap<[string,unknown]>(f=>{
      const value=row[f.name];
      if(value==='')return f.nullable?[[f.name,null]]:f.required?[[f.name,value]]:[];
      return [[f.name,f.type?Number(value):value]];
    })));
  }
  validateDemoBatch(batch);
  if(batch.batch_id.startsWith('DEMO-')){
    const identifiers=loadIdentifierMap();
    if(batch.tables.patients.every(p=>identifiers[p.patient_id])){
      for(const table of tables)batch.tables[table.name]=batch.tables[table.name].map(row=>remapSyntheticRow(table.name,row,identifiers));
      batch.batch_id=batch.batch_id.replace(/^DEMO-/,'BATCH-');validateDemoBatch(batch);
    }
  }
  return batch;
}

async function sourceRequest(table:Table,key?:string,method='GET',body?:Row,headers:Record<string,string>={},signal?:AbortSignal) {
  const response=await fetch(`http://127.0.0.1:${ports[table.source]}/${table.name}${key===undefined?'':'/'+encodeURIComponent(key)}`,{
    method,headers:{...(sourceToken?{'x-api-key':sourceToken}:{}),...(body?{'content-type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)
  });
  if(method==='GET' && response.status===404)return null;
  const data=await response.json() as Row;
  if(!response.ok)throw new AppError(response.status,`${table.source}.${table.name}: ${data.error||'Source request failed'}`);
  return data;
}
export type FeedProgress={mode:'hospital';group_size:1|2;interval_ms:number;tick:number;total_ticks:number;patients_registered:number;patients_total:number;references_done:boolean;next_tick_at?:string};
export type ImportReceipt={file:string;hash:string;batch_id:string;status:'queued'|'importing'|'paused'|'completed'|'failed';created:number;reused:number;finalized:number;updated_at:string;error?:string;progress?:FeedProgress;replayed?:boolean};
export type ImportOptions={intervalMs?:number;groupSize?:1|2;signal?:AbortSignal;onProgress?:(receipt:ImportReceipt)=>void|Promise<void>};

export async function importDemoFile(file:string,receiptDirectory=path.join(dataDir,'demo-imports'),options:ImportOptions={}):Promise<ImportReceipt> {
  const bytes=fs.readFileSync(file);
  const hash=createHash('sha256').update(bytes).digest('hex');
  const batch=readDemoZip(bytes);
  fs.mkdirSync(receiptDirectory,{recursive:true});
  const receiptFile=path.join(receiptDirectory,hash+'.json');
  const previous=fs.existsSync(receiptFile)?JSON.parse(fs.readFileSync(receiptFile,'utf8')) as ImportReceipt:undefined;
  if(previous?.status==='completed')return {...previous,replayed:true};
  const receipt:ImportReceipt={file:path.resolve(file),hash,batch_id:batch.batch_id,status:'importing',created:previous?.created||0,reused:previous?.reused||0,finalized:previous?.finalized||0,updated_at:new Date().toISOString(),progress:previous?.progress};
  const paced=!!receipt.progress||(options.intervalMs||0)>0;
  if(paced&&!receipt.progress){
    const group=options.groupSize||1,interval=options.intervalMs||5000;
    if(![1,2].includes(group)||!Number.isFinite(interval)||interval<10||interval>3600000)throw new AppError(400,'Use 1 or 2 patients per group and an interval between 10 ms and one hour');
    receipt.progress={mode:'hospital',group_size:group,interval_ms:interval,tick:0,total_ticks:Math.ceil(batch.tables.patients.length/group)+2,patients_registered:0,patients_total:batch.tables.patients.length,references_done:false};
  }
  function save() {receipt.updated_at=new Date().toISOString();fs.writeFileSync(receiptFile+'.tmp',JSON.stringify(receipt,null,2)+'\n');fs.renameSync(receiptFile+'.tmp',receiptFile);}
  const table=(name:string)=>tables.find(t=>t.name===name)!;
  const request=(t:Table,key?:string,method='GET',body?:Row,headers?:Record<string,string>)=>sourceRequest(t,key,method,body,headers,options.signal);
  async function ensure(name:string,row:Row){
    options.signal?.throwIfAborted();const t=table(name),key=keyOf(t,row),current=await request(t,key);
    if(current){
      const compare=fieldNames(t).filter(f=>name!=='cultures'||!['n_isolates','result','status'].includes(f));
      if(compare.some(f=>(row[f]??null)!==(current[f]??null)))throw new AppError(409,`${name}/${key} already exists with different values; existing data was preserved`);
      if(name==='cultures'&&current.status==='final'&&(current.result!==row.result||row.status!=='final'))throw new AppError(409,`Culture ${key} was already finalized differently; existing result was preserved`);
      receipt.reused++;save();return false;
    }
    const payload=name==='cultures'?{...row,n_isolates:0,result:null,status:'registered'}:row;
    await request(t,undefined,'POST',payload,{'idempotency-key':`csv-${batch.batch_id}-${name}-${key}`});receipt.created++;save();return true;
  }
  async function finalize(row:Row){
    options.signal?.throwIfAborted();const t=table('cultures'),current=await request(t,row.culture_id);
    if(!current||current.n_isolates!==row.n_isolates)throw new AppError(422,`Culture ${row.culture_id}: isolate count differs from the CSV`);
    if(current.status!==row.status||current.result!==row.result){await request(t,row.culture_id,'PATCH',{status:row.status,result:row.result},{'if-match':String(current.record_version)});receipt.finalized++;save();}
  }
  save();
  try {
    if(!paced){
      for(const name of importOrder)for(const row of batch.tables[name])await ensure(name,row);
      for(const row of batch.tables.cultures)await finalize(row);
    }else{
      const progress=receipt.progress!,groupCount=Math.ceil(batch.tables.patients.length/progress.group_size);
      if(!progress.references_done){
        let additions=0;
        for(const name of ['wards','antibiotics','guidelines','specimen_types'])for(const row of batch.tables[name]){
          if(await ensure(name,row))if(++additions%progress.group_size===0)await pause(progress.interval_ms,undefined,{signal:options.signal});
        }
        progress.references_done=true;save();
      }
      const groups=Array.from({length:groupCount},(_,index)=>{
        const patients=batch.tables.patients.slice(index*progress.group_size,(index+1)*progress.group_size),ids=new Set(patients.map(p=>p.patient_id));
        const cultures=batch.tables.cultures.filter(c=>ids.has(c.patient_id)),cultureIds=new Set(cultures.map(c=>c.culture_id));
        const isolates=batch.tables.isolates.filter(i=>cultureIds.has(i.culture_id)),isolateIds=new Set(isolates.map(i=>i.isolate_id));
        return {patients,cultures,isolates,stays:batch.tables.ward_stays.filter(s=>ids.has(s.patient_id)),tests:batch.tables.ast_results.filter(a=>isolateIds.has(a.isolate_id))};
      });
      while(progress.tick<progress.total_ticks){
        options.signal?.throwIfAborted();
        const due=progress.next_tick_at?Date.parse(progress.next_tick_at)-Date.now():0;if(due>0)await pause(due,undefined,{signal:options.signal});
        // Pipeline cohorts: new patients/samples now, organisms next tick,
        // reported S/R and finalization the tick after. Pending CSV cases stay pending.
        const results=groups[progress.tick-2],identify=groups[progress.tick-1],register=groups[progress.tick];
        if(results){for(const row of results.tests)await ensure('ast_results',row);for(const row of results.cultures)await finalize(row);}
        if(identify)for(const row of identify.isolates)await ensure('isolates',row);
        if(register){for(const row of register.patients)await ensure('patients',row);for(const row of register.stays)await ensure('ward_stays',row);for(const row of register.cultures)await ensure('cultures',row);}
        progress.tick++;progress.patients_registered=Math.min(progress.tick*progress.group_size,progress.patients_total);progress.next_tick_at=new Date(Date.now()+progress.interval_ms).toISOString();save();
        await options.onProgress?.(structuredClone(receipt));
      }
    }
    receipt.status='completed';save();return receipt;
  } catch(error) {
    if(options.signal?.aborted){receipt.status='paused';save();return receipt;}
    receipt.status='failed';receipt.error=(error as Error).message;save();
    throw new Error(`Batch ${batch.batch_id} stopped: ${receipt.error}. Saved records remain in their sources; retry the same file to resume. Receipt: ${receiptFile}`);
  }
}

export function watchDemoInbox(directory=process.env.SYNTHETIC_INBOX||path.join(root,'output','data','inbox'),receiptDirectory?:string,options:ImportOptions={}) {
  fs.mkdirSync(directory,{recursive:true});
  let stopped=false,active:Promise<void>|undefined;
  const completed=new Set<string>(),retryAfter=new Map<string,number>(),controller=new AbortController();
  const intervalMs=options.intervalMs??Number(process.env.SYNTHETIC_IMPORT_INTERVAL_MS||5000),groupSize=options.groupSize??Number(process.env.SYNTHETIC_IMPORT_GROUP_SIZE||1) as 1|2;
  if(!Number.isFinite(intervalMs)||intervalMs<10||intervalMs>3600000||![1,2].includes(groupSize))throw new AppError(400,'Invalid synthetic feed settings: choose group size 1 or 2 and a positive interval between 10 ms and one hour');
  async function scan() {
    for(const name of fs.readdirSync(directory).filter(n=>n.toLowerCase().endsWith('.zip')).sort()) {
      if(stopped)break;
      const file=path.join(directory,name);
      const stat=fs.statSync(file);if(!stat.isFile()||stat.size>50*1024*1024)continue;
      const fingerprint=`${name}:${stat.size}:${stat.mtimeMs}`;
      if(completed.has(fingerprint)||(retryAfter.get(fingerprint)||0)>Date.now())continue;
      try {
        const receipt=await importDemoFile(file,receiptDirectory,{...options,intervalMs,groupSize,signal:controller.signal,onProgress:async receipt=>{
          console.log(`Synthetic feed ${receipt.batch_id}: ${receipt.progress!.patients_registered}/${receipt.progress!.patients_total} patients registered · tick ${receipt.progress!.tick}/${receipt.progress!.total_ticks}`);await options.onProgress?.(receipt);
        }});
        if(receipt.status==='completed')completed.add(fingerprint);retryAfter.delete(fingerprint);
        console.log(receipt.replayed?`Synthetic CSV batch ${receipt.batch_id}: already imported; skipped`:`Synthetic CSV batch ${receipt.batch_id}: ${receipt.status} (${receipt.created} created, ${receipt.reused} reused)`);
      } catch(error) {
        console.error(`[CSV inbox] ${(error as Error).message}`);retryAfter.set(fingerprint,Date.now()+30000);
      }
    }
  }
  function tick() {if(!stopped&&!active)active=scan().catch(e=>console.error('[CSV inbox]',e.message)).finally(()=>{active=undefined;});}
  tick();const timer=setInterval(tick,2000);
  return {directory,intervalMs,groupSize,async stop(){stopped=true;controller.abort();clearInterval(timer);await active;}};
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const file=process.argv[2];
  if(!file) {console.error('Usage: npm.cmd run demo:import -- path/to/synthetic_hospital_batch.zip');process.exitCode=1;}
  else try {console.log(JSON.stringify(await importDemoFile(path.resolve(file)),null,2));}catch(error){console.error((error as Error).message);process.exitCode=1;}
}
