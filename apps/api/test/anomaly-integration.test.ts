import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import Fastify from 'fastify';

process.env.ADT_PORT='19101';process.env.LIS_PORT='19102';process.env.FORMULARY_PORT='19103';
const {SourceStore}=await import('../src/source-store.js');
const {createSourceApi}=await import('../src/source-api.js');
const {HubStore,sourceHeaders}=await import('../src/hub-store.js');
const {startPostgres}=await import('../src/postgres.js');
const {sourceNames}=await import('../src/config.js');
const {bootstrapMessages,encodeResource,messageBundle}=await import('../src/fhir-mapping.js');
const {tables}=await import('../src/catalog.js');
const {receiveFhir,registerFhirIntake}=await import('../src/fhir-intake.js');
const {AnomalyDetector,anomalyRules,day}=await import('../src/anomaly-detector.js');
const {enqueueAnomalyWork,assistantAnomalies}=await import('../src/anomaly-store.js');
const {registerAnomalies}=await import('../src/anomaly-api.js');
const {AnomalyDemoService,registerAnomalyDemo}=await import('../src/anomaly-demo.js');
const {AssistantSearch}=await import('../src/assistant-search.js');

test('anomaly pipeline survives duplicate delivery, corrections, review races, source gaps and restart',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'amr-anomalies-')),database=`amr_anomaly_test_${Date.now()}`;
  const stores=Object.fromEntries(sourceNames.map(s=>[s,new SourceStore(s,directory)]));
  const apps=[] as Awaited<ReturnType<typeof createSourceApi>>[];let admin:pg.Pool|undefined,pool:pg.Pool|undefined,detector:InstanceType<typeof AnomalyDetector>|undefined;
  const api=Fastify({ajv:{customOptions:{removeAdditional:false}}});
  api.setErrorHandler((error,_request,reply)=>reply.code((error as any).statusCode||500).send({error:(error as Error).message}));
  try{
    for(const source of sourceNames){const app=await createSourceApi(stores[source]);await app.listen({host:'127.0.0.1',port:source==='adt'?19101:source==='lis'?19102:19103});apps.push(app);}
    admin=await startPostgres();await admin.query(`CREATE DATABASE ${database}`);
    if(process.env.DATABASE_URL){const url=new URL(process.env.DATABASE_URL);url.pathname='/'+database;pool=new pg.Pool({connectionString:url.toString()});}else pool=new pg.Pool({host:'127.0.0.1',port:55432,user:'amr_hub',database});
    const hub=new HubStore(pool);hub.initialMessages=source=>bootstrapMessages(stores[source]);await hub.initialize();await hub.sync();
    const events:any[]=[];hub.onChange=event=>events.push(event);let clock=new Date();detector=new AnomalyDetector(hub,()=>clock);
    registerFhirIntake(api,hub);registerAnomalies(api,hub);
    const demo=new AnomalyDemoService(hub,stores,async(source,bundle)=>{const response=await api.inject({method:'POST',url:'/api/intake/fhir/'+source,headers:sourceHeaders(),payload:bundle});return {status:response.statusCode,body:response.json()};});registerAnomalyDemo(api,demo);
    const drain=async()=>{for(let i=0;i<3;i++)await hub.sync();await detector!.tick();};
    let resistance:any,cluster:any;
    await t.test('isolated source API scenario creates the expected live resistance signal and persisted evidence',async()=>{
      const result=await demo.load('resistance');assert.equal(result.patients,100);await drain();
      const rows=(await pool!.query("SELECT * FROM anomaly_alerts WHERE active AND type='resistance'")).rows;assert.equal(rows.length,1,JSON.stringify((await pool!.query('SELECT scope_key,error FROM anomaly_jobs')).rows));resistance=rows[0];
      assert.equal(resistance.evidence.current.positive,30);assert.equal(resistance.evidence.current.total,40);assert.equal(resistance.evidence.baseline.positive,6);assert.equal(resistance.evidence.baseline.total,60);
      const details=await api.inject('/api/anomalies/'+resistance.id);assert.equal(details.statusCode,200);assert.equal(details.json().records_total,40);
      const matching=await api.inject('/api/anomalies?q='+result.patient_id);assert.equal(matching.json().total,1);assert.ok(events.some(e=>e.type==='anomalies.updated'));
      const context=await new AssistantSearch(hub).search({message:'Explain patient '+result.patient_id,include_prediction:false});assert.equal(context.anomalies.alerts[0].id,resistance.id);
      const missing=await new AssistantSearch(hub).search({message:'Patient ID UNKNOWN',include_prediction:false});assert.equal(missing.anomalies.alerts.length,0);
    });
    await t.test('acknowledgement persists, concurrent stale reviews fail and duplicate FHIR adds no alerts or jobs',async()=>{
      let response=await api.inject({method:'PATCH',url:`/api/anomalies/${resistance.id}/review`,payload:{status:'acknowledged',expected_version:resistance.version,note:'Reviewed test cohort'}});assert.equal(response.statusCode,200);
      response=await api.inject({method:'PATCH',url:`/api/anomalies/${resistance.id}/review`,payload:{status:'dismissed',expected_version:resistance.version,note:'Stale'}});assert.equal(response.statusCode,409);
      const before=(await pool!.query('SELECT sum(generation)::integer AS n FROM anomaly_jobs')).rows[0].n;
      const replay=await demo.replay('resistance');assert.equal(replay.body.duplicate,true);assert.equal((await pool!.query('SELECT sum(generation)::integer AS n FROM anomaly_jobs')).rows[0].n,before);
      const count=(await pool!.query('SELECT count(*)::integer AS n FROM anomaly_alerts')).rows[0].n;assert.equal(count,1);
      await enqueueAnomalyWork(pool!,{ward_codes:['ANOM-R']},'lis');await detector!.tick();assert.equal((await pool!.query('SELECT status FROM anomaly_alerts WHERE id=$1',[resistance.id])).rows[0].status,'acknowledged');
    });
    await t.test('corrections resolve a signal without deleting evidence and a restored scenario starts a new episode',async()=>{
      await demo.correct('resistance');await drain();let row=(await pool!.query('SELECT * FROM anomaly_alerts WHERE id=$1',[resistance.id])).rows[0];assert.equal(row.status,'resolved');assert.equal(row.active,false);
      assert.equal((await api.inject('/api/anomalies/'+row.id)).json().records_total,40);
      await demo.load('resistance');await drain();row=(await pool!.query('SELECT * FROM anomaly_alerts WHERE id=$1',[resistance.id])).rows[0];assert.equal(row.id,resistance.id);assert.equal(row.episode,2);assert.equal(row.status,'open');
      const repeated=await demo.load('resistance');assert.equal(repeated.reused,true);assert.equal((await pool!.query("SELECT count(*)::integer AS n FROM adt.patients WHERE home_area='Anomaly test data'")).rows[0].n,100);
    });
    await t.test('cluster scenario flags five distinct patients without being a confirmed outbreak or a duplicate test count',async()=>{
      await demo.load('cluster');await drain();cluster=(await pool!.query("SELECT * FROM anomaly_alerts WHERE active AND type='cluster'")).rows[0];assert.ok(cluster);assert.equal(cluster.flag,'mrsa');assert.equal(cluster.evidence.current.positive,5);assert.equal(cluster.evidence.current.total,10);assert.equal(cluster.evidence.baseline.total,60);
      const context=await assistantAnomalies(pool!,{ward_codes:['ANOM-C']});assert.equal(context.alerts[0].id,cluster.id);assert.match(context.interpretation,/not diagnoses or confirmed outbreaks/);
      const other=await assistantAnomalies(pool!,{ward_codes:['UNRELATED']});assert.equal(other.alerts.length,0);
    });
    await t.test('saved jobs and alert review state survive worker restart and competing workers',async()=>{
      await enqueueAnomalyWork(pool!,{ward_codes:['ANOM-C']},'lis');const restarted=new AnomalyDetector(hub,()=>clock);await Promise.all([restarted.tick(),detector!.tick()]);await restarted.tick();
      assert.equal((await pool!.query("SELECT count(*)::integer AS n FROM anomaly_alerts WHERE type='cluster'")).rows[0].n,1);assert.equal((await pool!.query("SELECT count(*)::integer AS n FROM anomaly_jobs WHERE generation>processed_generation")).rows[0].n,0);
      await restarted.stop();await demo.correct('cluster');await drain();assert.equal((await pool!.query('SELECT status FROM anomaly_alerts WHERE id=$1',[cluster.id])).rows[0].status,'resolved');
    });
    await t.test('malformed integration test is quarantined and repeated rejection reuses the same inbox and alert',async()=>{
      const before=(await hub.overview()).totals.patients;await demo.load('integration');await detector!.tick();
      let rows=(await pool!.query("SELECT * FROM anomaly_alerts WHERE code='rejected_messages'")).rows;assert.equal(rows.length,1);const id=rows[0].id;
      assert.equal((await hub.overview()).totals.patients,before);assert.equal((await demo.replay('integration')).status,422);await detector!.tick();rows=(await pool!.query("SELECT * FROM anomaly_alerts WHERE code='rejected_messages'")).rows;assert.equal(rows.length,1);assert.equal(rows[0].id,id);assert.equal(rows[0].evidence.count,1);
    });
    function message(source:'adt'|'lis',table:string,row:any,sequence:number){const time=new Date().toISOString();return messageBundle(source,'anomaly-fixture-'+sequence,sequence,[encodeResource(tables.find(t=>t.name===table)!,{...row,record_version:1,created_at:time,updated_at:time},sequence)]);}
    await t.test('cross-source arrival grace prevents transient link alerts and late parents resolve a persistent integrity signal',async()=>{
      await receiveFhir(hub,'lis',message('lis','cultures',{culture_id:'ANOM-MISSING',patient_id:'NO-PARENT',ward_code:'NO-WARD',admission_date:null,age_years:66,sample_date:day(clock),specimen:'urine',result:null,n_isolates:0,status:'registered'},5000000));await detector!.tick();
      assert.equal((await pool!.query("SELECT count(*)::integer AS n FROM anomaly_alerts WHERE active AND code='unresolved_references'")).rows[0].n,0);
      clock=new Date(Date.now()+(anomalyRules.quality_grace_seconds+2)*1000);await enqueueAnomalyWork(pool!,{});await detector!.tick();assert.equal((await pool!.query("SELECT count(*)::integer AS n FROM anomaly_alerts WHERE active AND code='unresolved_references'")).rows[0].n,1);
      await receiveFhir(hub,'adt',message('adt','patients',{patient_id:'NO-PARENT',sex:'F',birth_year:1960,home_area:'Anomaly integrity fixture'},5000001));
      await receiveFhir(hub,'adt',message('adt','wards',{ward_code:'NO-WARD',ward_fi:'Testi',ward_en:'Integrity fixture',ward_type:'out',institution:'hospital'},5000002));await detector!.tick();assert.equal((await pool!.query("SELECT status FROM anomaly_alerts WHERE code='unresolved_references'")).rows[0].status,'resolved');
    });
    await t.test('orphaned AST and inconsistent final counts are detected after grace and resolve on repair',async()=>{
      clock=new Date();await receiveFhir(hub,'lis',message('lis','ast_results',{isolate_id:'MISSING-I',antibiotic_code:'TEST-AMP',result:'R',guideline:'ANOMALY-TEST-1'},5000003));await detector!.tick();
      assert.equal((await pool!.query("SELECT count(*)::integer AS n FROM anomaly_alerts WHERE active AND code='orphaned_results'")).rows[0].n,0);
      clock=new Date(Date.now()+(anomalyRules.quality_grace_seconds+2)*1000);await enqueueAnomalyWork(pool!,{});await detector!.tick();assert.equal((await pool!.query("SELECT count(*)::integer AS n FROM anomaly_alerts WHERE active AND code='orphaned_results'")).rows[0].n,1);
      await receiveFhir(hub,'lis',message('lis','isolates',{isolate_id:'MISSING-I',culture_id:'ANOM-MISSING',isolate_no:1,organism:'Escherichia coli',quantity:null,esbl:0,mrsa:0,vre:0,cpe:0},5000004));await detector!.tick();assert.equal((await pool!.query("SELECT status FROM anomaly_alerts WHERE code='orphaned_results'")).rows[0].status,'resolved');
      clock=new Date();const bad={culture_id:'COUNTBAD',patient_id:'NO-PARENT',ward_code:'NO-WARD',admission_date:null,age_years:66,sample_date:day(clock),specimen:'urine',result:'positive',n_isolates:2,status:'final'};
      await receiveFhir(hub,'lis',message('lis','cultures',bad,5000005));clock=new Date(Date.now()+(anomalyRules.quality_grace_seconds+2)*1000);await enqueueAnomalyWork(pool!,{});await detector!.tick();assert.equal((await pool!.query("SELECT count(*)::integer AS n FROM anomaly_alerts WHERE active AND code='final_count_mismatch'")).rows[0].n,1);
      await receiveFhir(hub,'lis',message('lis','cultures',{...bad,n_isolates:0},5000006));await detector!.tick();assert.equal((await pool!.query("SELECT status FROM anomaly_alerts WHERE code='final_count_mismatch'")).rows[0].status,'resolved');
    });
    await t.test('offline sources pause biological evaluations and preserve pending jobs until recovery',async()=>{
      hub.sourceStatus.lis={source:'lis',status:'offline',last_sync_at:new Date(clock.valueOf()-300000).toISOString(),error:'Test outage'};
      await enqueueAnomalyWork(pool!,{ward_codes:['ANOM-R']},'lis');await detector!.tick();let pending=(await pool!.query("SELECT * FROM anomaly_jobs WHERE scope_key='ward:ANOM-R'")).rows[0];assert.ok(Number(pending.generation)>Number(pending.processed_generation));assert.match(pending.error,/paused/);
      assert.equal((await pool!.query("SELECT count(*)::integer AS n FROM anomaly_alerts WHERE active AND code='source_offline'")).rows[0].n,1);
      hub.sourceStatus.lis={source:'lis',status:'connected',last_sync_at:clock.toISOString()};await enqueueAnomalyWork(pool!,{ward_codes:['ANOM-R']},'lis');await detector!.tick();pending=(await pool!.query("SELECT * FROM anomaly_jobs WHERE scope_key='ward:ANOM-R'")).rows[0];assert.equal(pending.error,null);assert.equal((await pool!.query("SELECT status FROM anomaly_alerts WHERE code='source_offline'")).rows[0].status,'resolved');
      const summary=(await api.inject('/api/anomalies/summary')).json();assert.equal(summary.counts.resistance,1);assert.equal(summary.rules.minimum_tested,30);assert.ok(summary.last_evaluated_at);
    });
  }finally{
    await detector?.stop();await api.close();for(const app of apps)await app.close();Object.values(stores).forEach(store=>store.close());await pool?.end();
    if(admin){await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);await admin.end();}
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(directory).startsWith('amr-anomalies-'));fs.rmSync(directory,{recursive:true,force:true});
  }
});
