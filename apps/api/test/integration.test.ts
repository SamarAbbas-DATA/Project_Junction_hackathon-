import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import AdmZip from 'adm-zip';
import { tables, fieldNames } from '../src/catalog.js';

// Tests use their own ports, SQLite files and a uniquely named PostgreSQL DB.
process.env.ADT_PORT='18001';process.env.LIS_PORT='18002';process.env.FORMULARY_PORT='18003';
const {SourceStore}=await import('../src/source-store.js');
const {createSourceApi}=await import('../src/source-api.js');
const {HubStore}=await import('../src/hub-store.js');
const {startPostgres}=await import('../src/postgres.js');
const {executeTool,commitProposal}=await import('../src/chat.js');
const {sourceHeaders}=await import('../src/hub-store.js');
const countBatchPatients=async(batch:any,request:any)=>(await Promise.all(batch.tables.patients.map((p:any)=>request('adt','/patients/'+p.patient_id)))).filter((r:any)=>r.status===200).length;
const {AssistantSearch}=await import('../src/assistant-search.js');
const {ports,sourceNames}=await import('../src/config.js');
const {generateDemoBatch,toCsv,validateDemoBatch}=await import('../src/demo-data.js');
const {importDemoFile,watchDemoInbox}=await import('../src/demo-import.js');
const {bootstrapMessages}=await import('../src/fhir-mapping.js');
const {fhirChanges,startFhirSender}=await import('../src/fhir-source.js');
const {receiveFhir,registerFhirIntake}=await import('../src/fhir-intake.js');
const {replayCompletedDemo}=await import('../src/demo-replay.js');
const {default:Fastify}=await import('fastify');

function writeBatch(file:string,batch:ReturnType<typeof generateDemoBatch>) {
  const zip=new AdmZip();
  zip.addFile('manifest.json',Buffer.from(JSON.stringify({...batch,tables:undefined})));
  for(const table of tables)zip.addFile(table.name+'.csv',Buffer.from(toCsv(fieldNames(table),batch.tables[table.name])));
  zip.writeZip(file);
}

test('source APIs and PostgreSQL hub preserve records, corrections and recovery',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'amr-integration-'));
  const stores=Object.fromEntries(sourceNames.map(s=>[s,new SourceStore(s,directory)]));
  stores.adt.transaction(()=>{
    stores.adt.insert('patients',{patient_id:'PTEST',sex:'F',birth_year:1980,home_area:'Test area'});
    stores.adt.insert('wards',{ward_code:'ED',ward_fi:'Testi',ward_en:'Test emergency',ward_type:'out',institution:'hospital'});
  });
  stores.formulary.transaction(()=>{
    stores.formulary.insert('antibiotics',{antibiotic_code:'AMP',antibiotic:'ampicillin',antibiotic_fi:'ampisilliini',class:'penicillins',reported_for:'all'});
    stores.formulary.insert('antibiotics',{antibiotic_code:'NIT',antibiotic:'nitrofurantoin',antibiotic_fi:'nitrofurantoiini',class:'nitrofurans',reported_for:'urine'});
    stores.formulary.insert('guidelines',{guideline:'EUCAST 2026',valid_from:null});
  });
  stores.lis.transaction(()=>{stores.lis.insert('specimen_types',{specimen:'urine',specimen_fi:'virtsa'});stores.lis.insert('specimen_types',{specimen:'blood',specimen_fi:'veri'});});
  const apps=[] as Awaited<ReturnType<typeof createSourceApi>>[];
  let admin:pg.Pool|undefined,pool:pg.Pool|undefined;
  const database=`amr_test_${Date.now()}`;
  async function request(source:'adt'|'lis'|'formulary',route:string,method='GET',body?:any,headers:Record<string,string>={}){
    const response=await fetch(`http://127.0.0.1:${ports[source]}${route}`,{method,headers:{...sourceHeaders(),...(body?{'content-type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});
    return {status:response.status,body:await response.json() as any};
  }
  try{
    for(const source of sourceNames){const app=await createSourceApi(stores[source]);await app.listen({host:'127.0.0.1',port:ports[source]});apps.push(app);}
    admin=await startPostgres();await admin.query(`CREATE DATABASE ${database}`);
    const connectionString=process.env.DATABASE_URL;
    if(connectionString){const url=new URL(connectionString);url.pathname='/'+database;pool=new pg.Pool({connectionString:url.toString()});}
    else pool=new pg.Pool({host:'127.0.0.1',port:55432,user:'amr_hub',database});
    const hub=new HubStore(pool);hub.initialMessages=source=>bootstrapMessages(stores[source]);await hub.initialize();await hub.sync();
    await t.test('snapshot import and source cursor are consistent',async()=>{
      assert.equal((await hub.overview()).totals.patients,1);
      const snapshot=stores.adt.snapshot();assert.equal(snapshot.cursor,2);assert.equal(snapshot.tables.patients.length,1);
      assert.equal((await pool!.query("SELECT last_event_id FROM sync_cursors WHERE source='adt'")).rows[0].last_event_id,'2');
    });
    let patient:any;
    await t.test('append is idempotent and emits exactly one event',async()=>{
      const data={patient_id:'PNEW',sex:'M',birth_year:1985,home_area:'North'};
      const first=await request('adt','/patients','POST',data,{'idempotency-key':'same-request'});assert.equal(first.status,201);patient=first.body;
      const retry=await request('adt','/patients','POST',data,{'idempotency-key':'same-request'});assert.equal(retry.status,200);
      const messages=(await request('adt','/fhir/changes?after=2')).body.messages;
      assert.equal(messages.length,1);assert.equal(messages[0].resourceType,'Bundle');assert.equal(messages[0].entry[0].resource.resourceType,'MessageHeader');
      assert.equal((await request('adt','/patients','POST',{...data,home_area:'Other'},{'idempotency-key':'same-request'})).status,409);
      await hub.sync();assert.equal((await hub.overview()).totals.patients,2);
    });
    await t.test('corrections require a current version and survive repeated synchronization',async()=>{
      assert.equal((await request('adt','/patients/PNEW','PATCH',{home_area:'South'})).status,428);
      const corrected=await request('adt','/patients/PNEW','PATCH',{home_area:'South'},{'if-match':String(patient.record_version)});assert.equal(corrected.status,200);assert.equal(corrected.body.record_version,2);
      assert.equal((await request('adt','/patients/PNEW','PATCH',{home_area:'West'},{'if-match':'1'})).status,409);
      await hub.sync();await hub.sync();
      assert.equal((await pool!.query("SELECT home_area FROM adt.patients WHERE patient_id='PNEW'")).rows[0].home_area,'South');
      assert.equal((await pool!.query("SELECT count(*)::integer AS n FROM event_log WHERE source='adt'")).rows[0].n,2);
    });
    const culture={culture_id:'CTEST',patient_id:'PTEST',ward_code:'ED',admission_date:null,age_years:46,sample_date:'2026-09-20',specimen:'urine',result:null,n_isolates:0,status:'registered'};
    await t.test('invalid references and dates cannot reach source records',async()=>{
      assert.equal((await request('lis','/cultures','POST',{...culture,patient_id:'MISSING'})).status,422);
      assert.equal((await request('lis','/cultures','POST',{...culture,sample_date:'2026-02-30'})).status,400);
      assert.equal((await request('lis','/cultures','POST',{...culture,unknown_column:'x'})).status,400);
      assert.equal((await request('lis','/cultures','POST',culture)).status,201);
      assert.equal((await request('lis','/cultures/CTEST')).body.result,null);
    });
    await t.test('isolates update parent counts atomically and tests validate antibiotic applicability',async()=>{
      assert.equal((await request('lis','/isolates','POST',{isolate_id:'ITEST',culture_id:'CTEST',isolate_no:1,organism:'Escherichia coli',quantity:'>=10^5'})).status,201);
      const c=(await request('lis','/cultures/CTEST')).body;assert.equal(c.n_isolates,1);assert.equal(c.status,'preliminary');assert.equal(c.result,'positive');
      assert.equal((await request('lis','/ast','POST',{isolate_id:'ITEST',antibiotic_code:'AMP',result:'R',guideline:'EUCAST 2026'})).status,201);
      assert.equal((await request('lis','/cultures/CTEST','PATCH',{status:'final'},{'if-match':String(c.record_version)})).status,200);
      await hub.sync();const data=await hub.antibiogram({from:'2026-09-01',to:'2026-09-30'});assert.equal(data.rows[0].tested,1);assert.equal(data.rows[0].resistance_pct,null);
      assert.equal((await request('lis','/cultures','POST',{...culture,culture_id:'CBLOOD',specimen:'blood'})).status,201);
      await request('lis','/isolates','POST',{isolate_id:'IBLOOD',culture_id:'CBLOOD',isolate_no:1,organism:'Escherichia coli'});
      assert.equal((await request('lis','/ast','POST',{isolate_id:'IBLOOD',antibiotic_code:'NIT',result:'S',guideline:'EUCAST 2026'})).status,422);
    });
    await t.test('cursor replay is safe and a restarted hub catches up',async()=>{
      await hub.sync();
      const before=(await pool!.query('SELECT count(*)::integer AS n FROM event_log')).rows[0].n;
      await pool!.query("UPDATE sync_cursors SET last_event_id=2 WHERE source='adt'");await hub.sync();
      const after=(await pool!.query('SELECT count(*)::integer AS n FROM event_log')).rows[0].n;
      assert.equal(after,before); // Retransmitted post-snapshot changes are ignored.
      await request('adt','/patients','POST',{patient_id:'PRESTART',sex:'F',birth_year:1990,home_area:'West'});
      const restarted=new HubStore(pool!);await restarted.initialize();await restarted.sync();
      assert.equal((await restarted.overview()).totals.patients,3);
    });
    await t.test('chat writes stay drafts until committed and retries do not append twice',async()=>{
      const drafted=await executeTool(hub,'propose_create_record',{source:'adt',table:'patients',record:{patient_id:'PCHAT',sex:'F',birth_year:2000,home_area:'Centre'}});
      assert.equal((await request('adt','/patients/PCHAT')).status,404);
      assert.equal((await commitProposal(hub,drafted.proposal.id)).status,'committed');
      assert.equal((await commitProposal(hub,drafted.proposal.id)).replayed,true);
      assert.equal((await request('adt','/patients?q=PCHAT')).body.total,1);
      await assert.rejects(()=>executeTool(hub,'run_sql',{sql:'DELETE FROM patients'}));
    });
    await t.test('first-isolate selection, minimum sample size and corrected AST results',async()=>{
      stores.adt.transaction(()=>{for(let n=0;n<30;n++)stores.adt.insert('patients',{patient_id:`PTH${n}`,sex:'F',birth_year:1980,home_area:'Test'});});
      stores.lis.transaction(()=>{
        for(let n=0;n<31;n++){
          const duplicate=n===30,id=`CSTATS${n}`,isolateId=`ISTATS${n}`;
          stores.lis.insert('cultures',{...culture,culture_id:id,patient_id:`PTH${duplicate?0:n}`,sample_date:duplicate?'2026-09-22':'2026-09-21',status:'final',result:'positive',n_isolates:1});
          stores.lis.insert('isolates',{isolate_id:isolateId,culture_id:id,isolate_no:1,organism:'Escherichia coli',quantity:'>=10^5',esbl:0,mrsa:0,vre:0,cpe:0});
          stores.lis.insert('ast_results',{isolate_id:isolateId,antibiotic_code:'AMP',result:duplicate?'R':'S',guideline:'EUCAST 2026'});
        }
      });
      await hub.sync();
      const stats=(await hub.antibiogram({from:'2026-09-01',to:'2026-09-30',specimen:'urine'})).rows.find(r=>r.antibiotic_code==='AMP');
      assert.equal(stats.tested,31);assert.equal(stats.resistant,1);assert.equal(Number(stats.resistance_pct),3.2);
      assert.equal((await request('lis','/ast/ITEST~AMP','PATCH',{result:'S'},{'if-match':'1'})).status,200);
      await hub.sync();
      const corrected=(await hub.antibiogram({from:'2026-09-01',to:'2026-09-30',specimen:'urine'})).rows.find(r=>r.antibiotic_code==='AMP');
      assert.equal(corrected.tested,31);assert.equal(corrected.resistant,0);assert.equal(Number(corrected.resistance_pct),0);
    });
    await t.test('one offline source does not stop the others, and reconnect resumes',async()=>{
      await apps[1].close();
      await request('adt','/patients','POST',{patient_id:'POFFLINE',sex:'M',birth_year:1990,home_area:'South'});
      await hub.sync();assert.equal(hub.sourceStatus.lis.status,'offline');
      assert.equal((await pool!.query("SELECT count(*)::integer AS n FROM adt.patients WHERE patient_id='POFFLINE'")).rows[0].n,1);
      apps[1]=await createSourceApi(stores.lis);await apps[1].listen({host:'127.0.0.1',port:ports.lis});
      await hub.sync();assert.equal(hub.sourceStatus.lis.status,'connected');
    });
    await t.test('patient directory and joined history preserve unsampled patients and exact test counts',async()=>{
      const search=await hub.patients({q:'PTEST'});assert.equal(search.total,1);assert.equal(search.rows[0].sample_count,2);assert.equal(search.rows[0].isolate_count,2);
      const history=await hub.patientHistory('PTEST');assert.ok(history);
      assert.equal(history.summary.samples,2);assert.equal(history.summary.isolates,2);assert.equal(history.summary.tests,1);
      const urine=history.cultures.find(c=>c.culture_id==='CTEST');assert.equal(urine.isolates[0].ast_results[0].result,'S');
      const without=await hub.patients({has_samples:'no'});assert.ok(without.rows.some(p=>p.patient_id==='PCHAT'));
      assert.equal((await hub.patients({q:"%' OR 1=1 --"})).total,0);
      assert.equal(await hub.patientHistory('UNKNOWN'),null);
      const overview=await hub.overview();assert.equal(overview.weekly.reduce((sum,w)=>sum+w.patients,0),31);assert.equal(overview.weekly.reduce((sum,w)=>sum+w.tests,0),32);
    });
    await t.test('synthetic CSV batch imports linked source records, updates the hub and can be replayed safely',async()=>{
      const batch=generateDemoBatch(50,'2026-10-17');validateDemoBatch(batch);
      const file=path.join(directory,'batch.zip'),receipts=path.join(directory,'receipts');writeBatch(file,batch);
      const imported=await importDemoFile(file,receipts);assert.equal(imported.status,'completed');assert.ok(imported.created>0);
      assert.equal(await countBatchPatients(batch,request),50);
      const positive=batch.tables.cultures.find(c=>c.result==='positive')!;
      const culture=(await request('lis','/cultures/'+positive.culture_id)).body;
      assert.equal(culture.status,'final');assert.equal(culture.n_isolates,positive.n_isolates);assert.ok(culture.isolates[0].ast_results.length>0);
      const pending=batch.tables.cultures.find(c=>c.status==='registered')!;
      assert.equal((await request('lis','/cultures/'+pending.culture_id)).body.result,null);
      // Force an API replay without the first receipt: matching data is reused.
      const replay=await importDemoFile(file,path.join(directory,'replay-receipts'));
      assert.equal(replay.created,0);assert.ok(replay.reused>0);
      assert.equal(await countBatchPatients(batch,request),50);
      await hub.sync();
      const history=await hub.patientHistory(positive.patient_id);assert.ok(history);
      assert.ok(history.cultures.some(c=>c.culture_id===positive.culture_id));assert.ok(history.summary.tests>0);
      const unsampled=await hub.patientHistory(batch.tables.patients[0].patient_id);assert.equal(unsampled?.summary.samples,0);
      assert.equal((await pool!.query('SELECT count(*)::integer AS n FROM formulary.antibiotics WHERE antibiotic_code=ANY($1::text[])',[batch.tables.antibiotics.map(a=>a.antibiotic_code)])).rows[0].n,3);
      // A changed CSV cannot silently overwrite an already imported source row.
      batch.tables.patients[0].home_area='Changed';writeBatch(path.join(directory,'conflict.zip'),batch);
      await assert.rejects(()=>importDemoFile(path.join(directory,'conflict.zip'),receipts),/different values/);
      assert.notEqual((await request('adt','/patients/'+batch.tables.patients[0].patient_id)).body.home_area,'Changed');
    });
    await t.test('a partial file import resumes after an offline source without duplicate patients',async()=>{
      const batch=generateDemoBatch(3,'2026-10-17'),file=path.join(directory,'resume.zip'),receipts=path.join(directory,'resume-receipts');writeBatch(file,batch);
      await apps[1].close();
      await assert.rejects(()=>importDemoFile(file,receipts),/retry the same file to resume/);
      assert.equal(await countBatchPatients(batch,request),3);
      apps[1]=await createSourceApi(stores.lis);await apps[1].listen({host:'127.0.0.1',port:ports.lis});
      assert.equal((await importDemoFile(file,receipts)).status,'completed');
      assert.equal(await countBatchPatients(batch,request),3);
    });
    await t.test('invalid synthetic links fail before any API writes, and the inbox imports new files automatically',async()=>{
      const invalid=generateDemoBatch(3,'2026-10-17');invalid.tables.cultures[0].patient_id='MISSING';
      const invalidFile=path.join(directory,'invalid.zip');writeBatch(invalidFile,invalid);
      await assert.rejects(()=>importDemoFile(invalidFile,path.join(directory,'invalid-receipts')),/Missing reference/);
      assert.equal(await countBatchPatients(invalid,request),0);
      const inbox=path.join(directory,'inbox');fs.mkdirSync(inbox);
      const receipts=path.join(directory,'auto-receipts'),watcher=watchDemoInbox(inbox,receipts,{intervalMs:25,groupSize:1});
      try {
        const batch=generateDemoBatch(3,'2026-10-17');writeBatch(path.join(inbox,'automatic.zip'),batch);
        const deadline=Date.now()+15000;
        let completed=false;
        while(Date.now()<deadline) {
          if(fs.existsSync(receipts))completed=fs.readdirSync(receipts).filter(f=>f.endsWith('.json')).some(f=>JSON.parse(fs.readFileSync(path.join(receipts,f),'utf8')).status==='completed');
          if(completed)break;
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        assert.ok(completed,'Inbox should finish importing the new CSV ZIP');
        assert.equal(await countBatchPatients(batch,request),3);
      } finally {await watcher.stop();}
    });
    await t.test('paced feed adds one or two patients per tick, stages lab results and resumes after interruption',async()=>{
      const batch=generateDemoBatch(5,'2026-10-17'),file=path.join(directory,'paced.zip'),receipts=path.join(directory,'paced-receipts');writeBatch(file,batch);
      const controller=new AbortController(),positive=batch.tables.cultures.find(c=>c.result==='positive')!,negative=batch.tables.cultures.find(c=>c.result==='negative')!,pending=batch.tables.cultures.find(c=>c.status==='registered')!;
      const snapshots:{tick:number;count:number;status?:string;tests?:number}[]=[];
      const paused=await importDemoFile(file,receipts,{intervalMs:30,groupSize:1,signal:controller.signal,onProgress:async receipt=>{
        await hub.sync();const tick=receipt.progress!.tick,count=await countBatchPatients(batch,request);assert.equal(count,Math.min(tick,5));
        const row=await request('lis','/cultures/'+positive.culture_id);snapshots.push({tick,count,status:row.status===200?row.body.status:undefined,tests:row.body.isolates?.reduce((sum:number,i:any)=>sum+i.ast_results.length,0)});
        if(tick===4){assert.equal(row.body.status,'registered');assert.equal(row.body.result,null);assert.equal(row.body.isolates.length,0);controller.abort();}
      }});
      assert.equal(paused.status,'paused');assert.equal(paused.progress!.tick,4);assert.equal(await countBatchPatients(batch,request),4);
      // The persisted group size wins over new options when resuming a partial file.
      const resumed=await importDemoFile(file,receipts,{intervalMs:10,groupSize:2,onProgress:async receipt=>{
        const row=(await request('lis','/cultures/'+positive.culture_id)).body;
        if(receipt.progress!.tick===5){assert.equal(row.status,'preliminary');assert.equal(row.isolates.length,positive.n_isolates);assert.ok(row.isolates.every((i:any)=>i.ast_results.length===0));}
        if(receipt.progress!.tick===6){assert.equal(row.status,'final');assert.ok(row.isolates.some((i:any)=>i.ast_results.length>0));}
      }});
      assert.equal(resumed.status,'completed');assert.equal(resumed.progress!.group_size,1);assert.equal(await countBatchPatients(batch,request),5);
      assert.equal((await request('lis','/cultures/'+negative.culture_id)).body.result,'negative');const waiting=(await request('lis','/cultures/'+pending.culture_id)).body;assert.equal(waiting.status,'registered');assert.equal(waiting.result,null);
      await hub.sync();const history=await hub.patientHistory(positive.patient_id);assert.equal(history!.cultures.find(c=>c.culture_id===positive.culture_id)!.status,'final');
      const cursor=stores.adt.snapshot().cursor;assert.equal((await importDemoFile(file,receipts,{intervalMs:10,groupSize:1})).replayed,true);assert.equal(stores.adt.snapshot().cursor,cursor);
      const pairs=generateDemoBatch(5,'2026-10-17'),pairsFile=path.join(directory,'pairs.zip');writeBatch(pairsFile,pairs);
      const counts:number[]=[];await importDemoFile(pairsFile,path.join(directory,'pairs-receipts'),{intervalMs:10,groupSize:2,onProgress:async()=>{counts.push(await countBatchPatients(pairs,request));}});
      assert.deepEqual(counts,[2,4,5,5,5]);
    });
    await t.test('assistant finds exact linked IDs, refreshes source facts and separates patient contexts',async()=>{
      await hub.sync();const search=new AssistantSearch(hub);
      const patient=await search.search({message:'Summarize ptest',include_prediction:false});
      assert.equal(patient.records.patients[0].record.patient_id,'PTEST');assert.equal(patient.records.patients[0].summary.tests,1);
      assert.equal(patient.records.cultures.length,2);
      const culture=await search.search({mode:'culture',identifier:'ctest',message:'Which organism was found?',include_prediction:false});
      assert.deepEqual(culture.focus.culture_ids,['CTEST']);assert.equal(culture.records.cultures.length,1);assert.equal(culture.records.cultures[0].isolates[0].organism,'Escherichia coli');
      assert.deepEqual(culture.records.antibiotic_reference.map((a:any)=>a.antibiotic_code),['AMP']);
      const isolate=await search.search({message:'Explain itest',include_prediction:false});assert.deepEqual(isolate.focus.culture_ids,['CTEST']);
      const follow=await search.search({message:'What are the test results?',focus:culture.focus,include_prediction:false});assert.deepEqual(follow.focus.culture_ids,['CTEST']);
      const other=await search.search({message:'Now show PNEW',focus:culture.focus,include_prediction:false});assert.equal(other.records.patients[0].record.patient_id,'PNEW');assert.equal(other.records.cultures.length,0);
      const missing=await search.search({message:'Summarize P999999',focus:culture.focus,identifier:'CTEST',include_prediction:false});assert.equal(missing.missing[0].id,'P999999');assert.equal(missing.records.patients.length,0);assert.equal(missing.records.overview,undefined);
      const ward=await search.search({mode:'ward',identifier:'ed',message:'Any pending samples?',include_prediction:false});assert.equal(ward.records.wards[0].record.ward_code,'ED');assert.ok(ward.records.wards[0].summary.pending>0);assert.ok(ward.records.wards[0].recent_samples.every((c:any)=>c.status!=='final'));assert.equal(ward.amr.length,0);
      const wrongWard=await search.search({message:'Summarize ward UNKNOWN',focus:ward.focus,include_prediction:false});assert.equal(wrongWard.missing[0].id,'UNKNOWN');assert.equal(wrongWard.records.wards.length,0);
      const general=await search.search({message:'How many samples are waiting?',include_prediction:false});assert.ok(general.records.overview.totals.cultures>0);assert.ok(general.records.pending_samples.length>0);
      const finnishWard=await search.search({message:'Osastokoodi ED: mitkä näytteet odottavat tuloksia?',include_prediction:false});assert.deepEqual(finnishWard.focus.ward_codes,['ED']);assert.ok(finnishWard.records.wards[0].recent_samples.every((c:any)=>c.status!=='final'));
      const finnishGeneral=await search.search({message:'Mitkä viljelyt ovat kesken? Näytä myös herkkyystiedot.',include_prediction:false});assert.ok(finnishGeneral.records.pending_samples.length>0);assert.ok(finnishGeneral.records.antibiogram);
      const finnishMissing=await search.search({message:'Potilastunnus UNKNOWN: tee yhteenveto',focus:patient.focus,include_prediction:false});assert.equal(finnishMissing.missing[0].id,'UNKNOWN');assert.equal(finnishMissing.records.patients.length,0);
      assert.equal((await search.search({message:"' OR 1=1; DROP TABLE adt.patients --",include_prediction:false})).records.patients.length,0);
      const model=await search.search({mode:'culture',identifier:'CTEST',message:'Summarize the AMR context'});assert.equal(model.amr[0].status,'available');assert.equal(model.amr[0].inputs.known_results.Ampicillin,'S');assert.ok(model.amr[0].model_id);
      assert.equal((await request('lis','/ast/ITEST~AMP','PATCH',{result:'R'},{'if-match':'2'})).status,200);await hub.sync();
      const updated=await search.search({message:'CTEST AMR context'});assert.equal(updated.records.cultures[0].isolates[0].ast[0][1],'R');assert.equal(updated.amr[0].inputs.known_results.Ampicillin,'R');
      stores.lis.insert('cultures',{culture_id:'CWOUND',patient_id:'PTEST',ward_code:'ED',admission_date:null,sample_date:'2026-10-18',specimen:'wound',age_years:46,status:'registered',n_isolates:0,result:null});
      await hub.sync();const wound=await search.search({message:'CWOUND'});assert.equal(wound.amr[0].status,'unsupported');assert.match(wound.amr[0].reason,/wound/);
    });
    await t.test('the running inbox defaults to 30 seconds and applies that interval to paused feeds',async()=>{
      const previous=process.env.SYNTHETIC_IMPORT_INTERVAL_MS;delete process.env.SYNTHETIC_IMPORT_INTERVAL_MS;
      const inbox=path.join(directory,'thirty-second-inbox'),receipts=path.join(directory,'thirty-second-receipts');fs.mkdirSync(inbox);
      const batch=generateDemoBatch(3,'2026-10-17'),file=path.join(inbox,'thirty.zip');writeBatch(file,batch);
      let first:any;const progress=new Promise<void>(resolve=>{first=resolve;});
      const watcher=watchDemoInbox(inbox,receipts,{onProgress:()=>first()});
      try{assert.equal(watcher.intervalMs,30000);await progress;await watcher.stop();assert.equal(await countBatchPatients(batch,request),1);
        const receipt=JSON.parse(fs.readFileSync(path.join(receipts,fs.readdirSync(receipts).find(n=>n.endsWith('.json'))!),'utf8'));assert.equal(receipt.progress.interval_ms,30000);assert.equal(receipt.status,'paused');assert.ok(Date.parse(receipt.progress.next_tick_at)>Date.now()+25000);
        const controller=new AbortController();controller.abort();await importDemoFile(file,receipts,{intervalMs:45000,useCurrentInterval:true,signal:controller.signal});
        const changed=JSON.parse(fs.readFileSync(path.join(receipts,fs.readdirSync(receipts).find(n=>n.endsWith('.json'))!),'utf8'));assert.equal(changed.progress.interval_ms,45000);assert.equal(await countBatchPatients(batch,request),1);
      }finally{await watcher.stop();if(previous===undefined)delete process.env.SYNTHETIC_IMPORT_INTERVAL_MS;else process.env.SYNTHETIC_IMPORT_INTERVAL_MS=previous;}
    });
    await t.test('FHIR intake saves originals, resists duplicates and older versions, and rejects changes atomically',async()=>{
      await hub.sync();
      const initial=(await pool!.query('SELECT count(*)::integer AS n FROM adt.patients')).rows[0].n;
      stores.adt.insert('patients',{patient_id:'PFHIR',sex:'F',birth_year:1991,home_area:'Original'});
      const cursor=stores.adt.snapshot().cursor-1,first=fhirChanges(stores.adt,cursor).messages[0];
      const received=await receiveFhir(hub,'adt',first);assert.equal(received.applied,1);
      assert.equal((await receiveFhir(hub,'adt',first)).duplicate,true);
      assert.equal((await receiveFhir(hub,'adt',Object.fromEntries(Object.entries(first).reverse()))).duplicate,true);
      stores.adt.update('patients','PFHIR',{home_area:'Corrected'},1);
      const correction=fhirChanges(stores.adt,cursor+1).messages[0];await receiveFhir(hub,'adt',correction);
      // A different delivery ID cannot make the previous resource version current.
      const old=structuredClone(first);old.identifier.value='redelivered-old-version';
      assert.equal((await receiveFhir(hub,'adt',old)).applied,0);
      assert.equal((await hub.record('adt','patients','PFHIR')).home_area,'Corrected');
      assert.equal((await pool!.query('SELECT count(*)::integer AS n FROM adt.patients')).rows[0].n,initial+1);
      const conflict=structuredClone(first);conflict.timestamp='2026-01-01T00:00:00Z';await assert.rejects(()=>receiveFhir(hub,'adt',conflict),/different content/);
      const invalid=structuredClone(correction);invalid.identifier.value='invalid-fhir-message';invalid.entry.push({resource:{resourceType:'Observation',id:'unsupported'}});
      await assert.rejects(()=>receiveFhir(hub,'adt',invalid),/not supported/);
      const saved=(await pool!.query("SELECT status,bundle FROM integration_inbox WHERE source='adt' AND message_id='invalid-fhir-message'")).rows[0];assert.equal(saved.status,'rejected');assert.deepEqual(saved.bundle,invalid);
      assert.equal((await hub.record('adt','patients','PFHIR')).home_area,'Corrected');
      const lab=await request('lis','/fhir/changes?after=0&limit=500');assert.equal(lab.status,200);
      const amended=lab.body.messages.flatMap((b:any)=>b.entry.map((e:any)=>e.resource)).find((r:any)=>r.resourceType==='Observation'&&r.status==='corrected');assert.ok(amended);
      const final=stores.lis.db.prepare("SELECT * FROM cultures WHERE status='final' AND result='positive' LIMIT 1").get() as any,labCursor=stores.lis.snapshot().cursor;
      stores.lis.update('cultures',final.culture_id,{sample_date:final.sample_date},final.record_version);
      const correctedReport=fhirChanges(stores.lis,labCursor).messages[0];assert.ok(correctedReport.entry.some((e:any)=>e.resource.resourceType==='DiagnosticReport'&&e.resource.status==='corrected'));
      await receiveFhir(hub,'lis',correctedReport);assert.equal((await hub.record('lis','cultures',final.culture_id)).status,'final');
      assert.equal((await request('adt','/snapshot')).status,404);assert.equal((await request('adt','/events')).status,404);
      await hub.sync();
    });
    await t.test('per-source sender pushes immediately and catches up after intake downtime',async()=>{
      await hub.sync();const endpoint=Fastify();registerFhirIntake(endpoint,hub);await endpoint.listen({host:'127.0.0.1',port:0});
      const address=endpoint.server.address();assert.ok(address&&typeof address!=='string');
      const url=`http://127.0.0.1:${address.port}/api/intake/fhir`,before=stores.adt.snapshot().cursor,sender=startFhirSender(stores.adt,url,before);
      const wait=async(fn:()=>Promise<boolean>)=>{const deadline=Date.now()+5000;while(!(await fn())){assert.ok(Date.now()<deadline,'FHIR delivery timed out');await new Promise(r=>setTimeout(r,20));}};
      try{
        stores.adt.insert('patients',{patient_id:'PPUSH',sex:'M',birth_year:1982,home_area:'Push'});
        await wait(async()=>!!(await pool!.query("SELECT 1 FROM adt.patients WHERE patient_id='PPUSH'")).rowCount&&sender.cursor===before+1);
        assert.equal((await pool!.query("SELECT last_event_id FROM sync_cursors WHERE source='adt'")).rows[0].last_event_id,String(before));
        assert.equal(sender.cursor,before+1);
      }finally{await sender.stop();await endpoint.close();}
      // The hub was down while this source commit occurred. A replacement
      // sender uses the durable outbox, without relying on a new database write.
      stores.adt.insert('patients',{patient_id:'PCATCHUP',sex:'F',birth_year:1978,home_area:'Catch-up'});
      const recovered=Fastify();registerFhirIntake(recovered,hub);await recovered.listen({host:'127.0.0.1',port:0});const next=recovered.server.address();assert.ok(next&&typeof next!=='string');
      const retry=startFhirSender(stores.adt,`http://127.0.0.1:${next.port}/api/intake/fhir`,before);
      try{await wait(async()=>!!(await pool!.query("SELECT 1 FROM adt.patients WHERE patient_id='PCATCHUP'")).rowCount);}finally{await retry.stop();await recovered.close();}
      await hub.sync();assert.equal(hub.sourceStatus.adt.cursor,stores.adt.snapshot().cursor);
    });
    await t.test('completed inbox cycles reset only feed-owned patients and restart without losing manual records',async()=>{
      const inbox=path.join(directory,'cycle-inbox'),receipts=path.join(directory,'cycle-receipts');fs.mkdirSync(inbox);
      const batch=generateDemoBatch(5,'2026-10-17'),file=path.join(inbox,'cycle.zip');writeBatch(file,batch);
      await importDemoFile(file,receipts);await hub.sync();
      const extra=generateDemoBatch(3,'2026-10-17'),extraFile=path.join(inbox,'extra.zip');writeBatch(extraFile,extra);
      const cursor=stores.adt.snapshot().cursor;
      assert.equal(replayCompletedDemo(stores,directory,inbox,receipts).reset,false);assert.equal(stores.adt.snapshot().cursor,cursor);
      const controller=new AbortController();await importDemoFile(extraFile,receipts,{intervalMs:10,signal:controller.signal,onProgress:()=>controller.abort()});
      assert.equal(replayCompletedDemo(stores,directory,inbox,receipts).reset,false);assert.equal(await countBatchPatients(extra,request),1);
      await importDemoFile(extraFile,receipts,{intervalMs:10});
      // A manually added culture protects this generated patient's entire graph.
      const protectedId=batch.tables.patients[0].patient_id;
      assert.equal((await request('lis','/cultures','POST',{culture_id:'CMANUAL',patient_id:protectedId,ward_code:'ED',admission_date:null,age_years:2026-batch.tables.patients[0].birth_year,sample_date:'2026-10-17',specimen:'urine',n_isolates:0,status:'registered',result:null},{'idempotency-key':'manual-culture'})).status,201);
      const refs=stores.formulary.list('antibiotics').total,original=(await hub.overview()).totals.patients;
      const reset=replayCompletedDemo(stores,directory,inbox,receipts);assert.equal(reset.reset,true);assert.equal(reset.patients,7);assert.equal(reset.protected_patients,1);assert.ok(reset.backup&&fs.existsSync(path.join(reset.backup,'plan.json')));
      assert.equal(await countBatchPatients(batch,request),1);assert.equal(await countBatchPatients(extra,request),0);
      assert.ok(stores.adt.get('patients','PTEST'));assert.ok(stores.adt.get('patients','PPUSH'));assert.ok(stores.lis.get('cultures','CMANUAL'));assert.equal(stores.formulary.list('antibiotics').total,refs);
      await hub.sync();assert.equal(await hub.patientHistory(extra.tables.patients[0].patient_id),null);
      assert.equal(replayCompletedDemo(stores,directory,inbox,receipts).reset,false);
      const restarted=await importDemoFile(file,receipts,{intervalMs:10});assert.equal(restarted.status,'completed');assert.ok(restarted.created>0);
      await importDemoFile(extraFile,receipts,{intervalMs:10});await hub.sync();assert.equal(await countBatchPatients(batch,request),5);assert.equal(await countBatchPatients(extra,request),3);
      assert.equal((await hub.overview()).totals.patients,original+3); // extra's three finished after the saved hub count
      assert.ok(stores.lis.get('cultures','CMANUAL'));assert.equal(stores.formulary.list('antibiotics').total,refs);
    });
  }finally{
    for(const app of apps)await app.close();Object.values(stores).forEach(s=>s.close());
    if(pool)await pool.end();
    if(admin){await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);await admin.end();}
    // Remove only the exact temporary directory created above.
    if(path.dirname(directory)!==os.tmpdir()||!path.basename(directory).startsWith('amr-integration-'))throw new Error('Unexpected temporary test path');
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
