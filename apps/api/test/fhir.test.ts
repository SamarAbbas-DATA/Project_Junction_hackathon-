import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tables,fieldNames,keyOf } from '../src/catalog.js';
import { generateDemoBatch } from '../src/demo-data.js';
import { sourceNames } from '../src/config.js';
import { SourceStore } from '../src/source-store.js';
import { bootstrapMessages,decodeMessage,encodeResource,messageBundle,logicalId } from '../src/fhir-mapping.js';
import { fhirChanges } from '../src/fhir-source.js';

test('all nine private table types round-trip through FHIR without losing IDs or nulls',()=>{
  const batch=generateDemoBatch(5,'2026-10-17'),stamp='2026-10-17T10:00:00.000Z';
  for(const table of tables)for(const data of batch.tables[table.name]){
    const row={...data,created_at:stamp,updated_at:stamp,record_version:1},resource=encodeResource(table,row,10),bundle=messageBundle(table.source,'roundtrip-'+keyOf(table,row),10,[resource]);
    const decoded=decodeMessage(table.source,bundle).changes[0];assert.equal(decoded.table.name,table.name);
    for(const f of fieldNames(table))assert.deepEqual(decoded.row[f]??null,row[f as keyof typeof row]??null,`${table.name}.${f}`);
    assert.match(resource.id,/^[A-Za-z0-9.-]{1,64}$/);assert.equal(decoded.row.created_at,stamp);
  }
});

test('unknowns remain unknown and amended/corrected reports retain their original wire status',()=>{
  const batch=generateDemoBatch(5,'2026-10-17'),table=tables.find(t=>t.name==='cultures')!,row={...batch.tables.cultures.find(c=>c.result==='positive'),updated_at:'2026-10-17T10:00:00Z',record_version:3};
  for(const status of ['final','corrected','amended']){
    const r=encodeResource(table,row,12,status),decoded=decodeMessage('lis',messageBundle('lis','report-'+status,12,[r])).changes[0];assert.equal(decoded.row.status,'final');assert.equal(decoded.resource.status,status);
  }
  const registered={...row,status:'registered',result:null,n_isolates:0};const r=encodeResource(table,registered,13);
  assert.equal(decodeMessage('lis',messageBundle('lis','pending-report',13,[r])).changes[0].row.result,null);
  const patientTable=tables.find(t=>t.name==='patients')!,patient={...batch.tables.patients[0],updated_at:row.updated_at},invalid=encodeResource(patientTable,patient,14);invalid.gender='unknown';
  assert.throws(()=>decodeMessage('adt',messageBundle('adt','unknown-gender',14,[invalid])),/required/);
  assert.equal(logicalId('patients','1018112'),logicalId('patients','1018112'));
});

test('initial loads are stable across retries and persisted change messages keep their exact payload',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'amr-fhir-')),stores=Object.fromEntries(sourceNames.map(s=>[s,new SourceStore(s,directory)]));
  try{
    stores.adt.insert('patients',{patient_id:'1018112',sex:'F',birth_year:1988,home_area:'North'});
    assert.deepEqual([...bootstrapMessages(stores.adt).messages],[...bootstrapMessages(stores.adt).messages]);
    const first=fhirChanges(stores.adt,0);stores.adt.update('patients','1018112',{home_area:'South'},1);
    assert.deepEqual(fhirChanges(stores.adt,0).messages[0],first.messages[0]);
    const deletion=stores.adt.db.prepare("DELETE FROM patients WHERE patient_id='1018112'");deletion.run();
    const tombstone=fhirChanges(stores.adt,2).messages[0];assert.equal(decodeMessage('adt',tombstone).changes[0].deleted,true);
    stores.adt.insert('patients',{patient_id:'1018112',sex:'F',birth_year:1988,home_area:'North'});
    stores.adt.insert('wards',{ward_code:'MED-02',ward_fi:'Sisataudit',ward_en:'Medicine',ward_type:'in',institution:'hospital'});
    const cursor=stores.adt.snapshot().cursor;
    stores.adt.insert('ward_stays',{stay_id:'STAY-1018112',patient_id:'1018112',ward_code:'MED-02',admission_date:'2026-10-17',origin:'derived_from_cultures'});
    const stay=fhirChanges(stores.adt,cursor).messages[0],resources=stay.entry.map((entry:any)=>entry.resource);
    assert.deepEqual(resources.map((r:any)=>r.resourceType),['MessageHeader','Patient','Location','Encounter']);
    const encounter=resources.at(-1);assert.equal(encounter.subject.identifier.value,'1018112');assert.equal(encounter.location[0].location.identifier.value,'MED-02');assert.equal(encounter.status,'unknown');assert.equal(decodeMessage('adt',stay).changes.length,3);
  }finally{for(const store of Object.values(stores))store.close();if(path.dirname(directory)!==os.tmpdir()||!path.basename(directory).startsWith('amr-fhir-'))throw new Error('Unexpected test path');fs.rmSync(directory,{recursive:true,force:true});}
});
