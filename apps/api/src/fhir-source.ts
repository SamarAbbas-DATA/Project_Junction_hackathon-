import { setTimeout as pause } from 'node:timers/promises';
import { AppError,sourceToken } from './config.js';
import { keyOf } from './catalog.js';
import { encodeResource,logicalId,messageBundle,profile,specimenResource,system } from './fhir-mapping.js';
import type { SourceStore,Row } from './source-store.js';

function eventBundle(store:SourceStore,event:Row){
  const table=store.table(event.entity),row=event.payload,deleted=event.operation==='delete';
  const currentVersion=(name:string,r:Row)=>Number((store.db.prepare('SELECT max(event_id) AS n FROM events WHERE entity=? AND record_key=?').get(name,keyOf(store.table(name),r)) as Row).n)||event.event_id;
  const encode=(name:string,r:Row,version:number)=>{
    let status:string|undefined;
    if(name==='cultures'&&r.status==='final'){
      const prior=store.db.prepare('SELECT payload FROM events WHERE entity=? AND record_key=? AND event_id<? ORDER BY event_id DESC LIMIT 1').get(name,r.culture_id,version) as Row|undefined;
      if(prior&&JSON.parse(prior.payload).status==='final')status='corrected';
    }
    return encodeResource(store.table(name),r,version,status);
  };
  const focus=encode(table.name,row,event.event_id),resources=new Map<string,Row>();
  const add=(r:Row)=>resources.set(`${r.resourceType}/${r.id}`,r);
  if(!deleted&&store.source==='adt'&&table.name==='ward_stays'){
    const patient=store.get('patients',row.patient_id),ward=store.get('wards',row.ward_code);
    if(patient)add(encode('patients',patient,currentVersion('patients',patient)));
    if(ward)add(encode('wards',ward,currentVersion('wards',ward)));
  }
  // Deletes are explicit tombstones; they must still work after all parent
  // rows have already gone (for example during a completed demo reset).
  if(!deleted&&store.source==='lis'){
    const isolate=table.name==='ast_results'?store.get('isolates',row.isolate_id):undefined;
    const cultureId=table.name==='cultures'?row.culture_id:table.name==='isolates'?row.culture_id:isolate?.culture_id;
    const culture=cultureId?store.get('cultures',cultureId):undefined;
    if(culture){
      const version=currentVersion('cultures',culture),report=encode('cultures',culture,version),specimen=specimenResource(culture,version);
      add({resourceType:'Patient',id:logicalId('patients',culture.patient_id),identifier:[{system:system('patient-id'),value:culture.patient_id}]});add(specimen);
      const organisms=store.db.prepare('SELECT * FROM isolates WHERE culture_id=? ORDER BY isolate_no').all(cultureId) as Row[];
      report.result=organisms.map(i=>({reference:`Observation/${logicalId('isolates',i.isolate_id)}`}));let reportVersion=version;
      for(const organism of organisms){
        const ownVersion=currentVersion('isolates',organism),observation=encode('isolates',organism,ownVersion),tests=store.db.prepare('SELECT * FROM ast_results WHERE isolate_id=? ORDER BY antibiotic_code').all(organism.isolate_id) as Row[];
        observation.hasMember=tests.map(test=>({reference:`Observation/${logicalId('ast_results',keyOf(store.table('ast_results'),test))}`}));add(observation);
        let organismVersion=ownVersion;
        for(const test of tests){const testVersion=currentVersion('ast_results',test);organismVersion=Math.max(organismVersion,testVersion);if(test.updated_at>observation.meta.lastUpdated)observation.meta.lastUpdated=test.updated_at;add(encode('ast_results',test,testVersion));}
        observation.meta.versionId=String(organismVersion);reportVersion=Math.max(reportVersion,organismVersion);if(observation.meta.lastUpdated>report.meta.lastUpdated)report.meta.lastUpdated=observation.meta.lastUpdated;
      }
      // Membership is part of the FHIR resource too: newly arriving AST rows
      // must version the organism/report context, even when their native rows
      // have not changed. Otherwise a receiver would correctly ignore the new links.
      report.meta.versionId=String(reportVersion);if(culture.status==='final'&&reportVersion>version)report.status='corrected';add(report);
    }
  }
  // The triggering resource is always the exact committed event payload,
  // even if later context is already available when catching up a backlog.
  const context=resources.get(`${focus.resourceType}/${focus.id}`);
  if(context?.result)focus.result=context.result;if(context?.hasMember)focus.hasMember=context.hasMember;
  add(focus);
  return messageBundle(store.source,`${store.source}-${event.event_id}`,event.event_id,[...resources.values()],{deleted,focus});
}

export function fhirChanges(store:SourceStore,since:number,limit=100){
  if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw new AppError(400,'limit must be between 1 and 500');
  const page=store.events(since,limit);
  const read=store.db.prepare('SELECT bundle FROM fhir_outbox WHERE event_id=?'),save=store.db.prepare('INSERT INTO fhir_outbox(event_id,bundle) VALUES(?,?)');
  const messages=page.events.map((event:Row)=>{
    const prior=read.get(event.event_id) as Row|undefined;
    if(prior)return JSON.parse(prior.bundle);
    const message=eventBundle(store,event);save.run(event.event_id,JSON.stringify(message));return message;
  });
  return {source:store.source,protocol:'FHIR R4',messages,next_cursor:page.next_cursor};
}

// One sender per hospital system. An API commit wakes it immediately; the
// short local check also notices SQL-only edits. Delivery is ordered, durable
// and retried, without waiting for the hub's catch-up interval.
export function startFhirSender(store:SourceStore,intakeUrl:string,initialCursor:number){
  const key='fhir_sender_cursor',saved=store.db.prepare('SELECT value FROM import_metadata WHERE key=?').get(key) as Row|undefined;
  let cursor=Math.max(initialCursor,Number(saved?.value)||0),active:Promise<void>|undefined,stopped=false,again=false;
  const controller=new AbortController();
  const save=()=>store.db.prepare('INSERT INTO import_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(cursor));
  async function deliver(){
    do{
      again=false;
      const page=fhirChanges(store,cursor,100);if(!page.messages.length)return;
      for(const message of page.messages){
        if(stopped)return;
        const response=await fetch(`${intakeUrl}/${store.source}`,{method:'POST',headers:{'content-type':'application/fhir+json',...(sourceToken?{'x-api-key':sourceToken}:{})},body:JSON.stringify(message),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
        if(!response.ok)throw new Error(`Intake HTTP ${response.status}: ${await response.text()}`);
        cursor=message.entry[0].resource.extension.find((e:Row)=>e.url===`${profile}/StructureDefinition/source-sequence`).valueInteger;save();
      }
      again=page.messages.length===100;
    }while(again&&!stopped);
  }
  function tick(){
    if(stopped)return;if(active){again=true;return;}
    active=deliver().catch(async error=>{if(!stopped){console.error(`[FHIR ${store.source}] ${error.message}`);await pause(1000,undefined,{signal:controller.signal}).catch(()=>{});}}).finally(()=>{active=undefined;});
  }
  const previous=store.onChange;store.onChange=()=>{previous();queueMicrotask(tick);};
  const timer=setInterval(tick,250);tick();
  return {async stop(){stopped=true;clearInterval(timer);store.onChange=previous;controller.abort();await active;},get cursor(){return cursor;}};
}
