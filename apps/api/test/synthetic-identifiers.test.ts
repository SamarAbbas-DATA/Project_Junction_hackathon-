import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SourceStore,type Row } from '../src/source-store.js';
import { sourceNames } from '../src/config.js';
import { migrateSyntheticIdentifiers } from '../src/migrate-synthetic-identifiers.js';
import { loadIdentifierMap,reservePatientRange,remapSyntheticRow } from '../src/synthetic-identifiers.js';
import { generateDemoBatch,validateDemoBatch } from '../src/demo-data.js';

test('synthetic identifier migration preserves records, references, source events and future ID uniqueness',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'amr-identifiers-'));
  const stores=Object.fromEntries(sourceNames.map(source=>[source,new SourceStore(source,directory)]));
  const prefix='DEMO-20261017-abcd1234',p=prefix+'-P0001',c=p+'-C1',i=c+'-I1',w=prefix+'-MED',a=prefix+'-AB1',g=prefix+'-TEST-ONLY';
  try{
    stores.adt.insert('patients',{patient_id:'1018112',sex:'F',birth_year:1980,home_area:'Existing'});
    stores.adt.insert('patients',{patient_id:'10000001',sex:'M',birth_year:1990,home_area:'Other ID format'});
    stores.adt.insert('patients',{patient_id:p,sex:'M',birth_year:1980,home_area:'Demo / North'});
    stores.adt.insert('wards',{ward_code:w,ward_en:'Demo medical ward',ward_fi:'Demo sisätaudit',ward_type:'in',institution:'hospital'});
    stores.adt.insert('ward_stays',{stay_id:c+'-STAY',patient_id:p,ward_code:w,admission_date:'2026-10-16',origin:'recorded'});
    stores.formulary.insert('antibiotics',{antibiotic_code:a,antibiotic:'Synthetic demo antibiotic 1',antibiotic_fi:'Demo',class:'synthetic_demo',reported_for:'all'});
    stores.formulary.insert('guidelines',{guideline:g,valid_from:'2026-10-17'});
    stores.lis.insert('specimen_types',{specimen:'urine',specimen_fi:'virtsa'});
    stores.lis.insert('cultures',{culture_id:c,patient_id:p,ward_code:w,admission_date:'2026-10-16',age_years:46,sample_date:'2026-10-17',specimen:'urine',result:'positive',n_isolates:1,status:'final'});
    stores.lis.insert('isolates',{isolate_id:i,culture_id:c,isolate_no:1,organism:'Escherichia coli',quantity:'10^5',mrsa:0,esbl:0,vre:0,cpe:0});
    stores.lis.insert('ast_results',{isolate_id:i,antibiotic_code:a,result:'R',guideline:g});
    const result=migrateSyntheticIdentifiers(stores,directory),map=loadIdentifierMap(directory);
    assert.equal(result.patients,1);assert.equal(result.changed,8);assert.ok(fs.existsSync(path.join(result.backup!,'lis_db.sqlite')));
    assert.equal(map[p],'1018113');assert.equal(stores.adt.get('patients',p),undefined);assert.equal(stores.adt.get('patients',map[p])?.home_area,'North');
    assert.equal(stores.adt.get('patients','1018112')?.home_area,'Existing');
    assert.equal(stores.adt.get('patients','10000001')?.home_area,'Other ID format');
    assert.equal(stores.adt.get('wards',map[w])?.ward_en,'Medical ward 2');
    const culture=stores.lis.get('cultures',map[c])!;assert.equal(culture.patient_id,map[p]);assert.equal(culture.ward_code,map[w]);assert.equal(culture.status,'final');
    assert.equal(stores.lis.get('isolates',map[i])?.culture_id,map[c]);assert.equal(stores.lis.get('ast_results',map[i]+'~'+map[a])?.result,'R');
    assert.equal(stores.formulary.get('antibiotics',map[a])?.class,'synthetic_reference');
    for(const source of sourceNames)assert.deepEqual(stores[source].db.prepare('PRAGMA foreign_key_check').all(),[]);
    const events:Row[]=stores.lis.events(0).events;assert.ok(events.some(e=>e.operation==='delete'&&e.record_key===c));assert.ok(events.some(e=>e.operation==='update'&&e.record_key===map[c]));
    const cursor=stores.lis.snapshot().cursor;assert.equal(migrateSyntheticIdentifiers(stores,directory).changed,0);assert.equal(stores.lis.snapshot().cursor,cursor);
    const first=reservePatientRange(50,directory),second=reservePatientRange(50,directory);assert.equal(first,1018114);assert.equal(second,first+50);
    const batch=generateDemoBatch(50,'2026-10-17',first);validateDemoBatch(batch);assert.ok(batch.tables.patients.every(row=>/^\d{7}$/.test(row.patient_id)));assert.ok(!JSON.stringify(batch.tables).includes('DEMO-'));
    const normalized=remapSyntheticRow('cultures',{culture_id:c,patient_id:p,ward_code:w},map);assert.equal(normalized.culture_id,map[c]);
  }finally{
    Object.values(stores).forEach(store=>store.close());
    if(path.dirname(directory)!==os.tmpdir()||!path.basename(directory).startsWith('amr-identifiers-'))throw new Error('Unexpected test path');
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
