import fs from 'node:fs';
import path from 'node:path';
import { tables,keyOf,type Table } from './catalog.js';
import { sourceNames,type SourceName } from './config.js';
import type { SourceStore,Row } from './source-store.js';
import { cultureIdentifier,stayIdentifier,loadIdentifierMap,remapSyntheticRow,reservePatientRange } from './synthetic-identifiers.js';

// One-time maintenance before source APIs open. Ordinary source API clients
// still cannot change primary identifiers. Historical events remain untouched.
export function migrateSyntheticIdentifiers(stores:Record<string,SourceStore>,directory:string) {
  const records:Record<string,Row[]>={};
  for(const table of tables){
    const columns=table.fields.map(f=>f.name).filter(k=>k.endsWith('_id')||k.endsWith('_code')||k==='guideline');
    records[table.name]=columns.length?stores[table.source].db.prepare(`SELECT * FROM ${table.name} WHERE ${columns.map(k=>`${k} LIKE 'DEMO-%'`).join(' OR ')} ORDER BY ${table.keys.join(',')}`).all() as Row[]:[];
  }
  if(!Object.values(records).some(rows=>rows.length))return {changed:0,patients:0,backup:null};
  const identifiers=loadIdentifierMap(directory),patients=records.patients.filter(p=>!identifiers[p.patient_id]);
  const start=patients.length?reservePatientRange(patients.length,directory):0;
  patients.forEach((p,i)=>identifiers[p.patient_id]=String(start+i));
  const occupied=(source:SourceName,table:string,column:string)=>new Set((stores[source].db.prepare(`SELECT ${column} FROM ${table}`).all() as Row[]).map(r=>r[column]));
  const wards=occupied('adt','wards','ward_code'),drugs=occupied('formulary','antibiotics','antibiotic_code'),guidelines=occupied('formulary','guidelines','guideline');
  for(const ward of records.wards)if(!identifiers[ward.ward_code]){
    const prefix=ward.ward_code.split('-').at(-1);let n=2,key='';do{key=`${prefix}-${String(n++).padStart(2,'0')}`;}while(wards.has(key));wards.add(key);identifiers[ward.ward_code]=key;
  }
  let drugNumber=1;
  for(const drug of records.antibiotics)if(!identifiers[drug.antibiotic_code]){let key='';do{key=`SYN-${String(drugNumber++).padStart(3,'0')}`;}while(drugs.has(key));drugs.add(key);identifiers[drug.antibiotic_code]=key;}
  for(const guideline of records.guidelines)if(!identifiers[guideline.guideline]){
    const date=guideline.valid_from||guideline.guideline.match(/DEMO-(\d{8})/)?.[1]?.replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3')||'2026-01-01';
    let key=`SYN-${date.replaceAll('-','')}`,n=2;while(guidelines.has(key))key=`SYN-${date.replaceAll('-','')}-${n++}`;guidelines.add(key);identifiers[guideline.guideline]=key;
  }
  const visits=new Map<string,number>();
  for(const culture of records.cultures)if(culture.culture_id.startsWith('DEMO-')&&!identifiers[culture.culture_id]){
    const patient=identifiers[culture.patient_id]||culture.patient_id,visit=(visits.get(patient)||0)+1;visits.set(patient,visit);identifiers[culture.culture_id]=cultureIdentifier(patient,culture.sample_date,visit);
  }
  for(const isolate of records.isolates)if(isolate.isolate_id.startsWith('DEMO-')&&!identifiers[isolate.isolate_id])identifiers[isolate.isolate_id]=`${identifiers[isolate.culture_id]||isolate.culture_id}-${isolate.isolate_no}`;
  for(const stay of records.ward_stays)if(stay.stay_id.startsWith('DEMO-')&&!identifiers[stay.stay_id])identifiers[stay.stay_id]=stayIdentifier(identifiers[stay.patient_id]||stay.patient_id,identifiers[stay.ward_code]||stay.ward_code,stay.admission_date);
  const changes:{table:Table;before:Row;after:Row}[]=[];
  for(const table of tables)for(const before of records[table.name]){
    const after=remapSyntheticRow(table.name,before,identifiers);if(JSON.stringify(before)===JSON.stringify(after))continue;
    const existing=stores[table.source].get(table.name,keyOf(table,after));
    if(keyOf(table,before)!==keyOf(table,after)&&existing)throw new Error(`Cannot rename ${table.name}: destination ${keyOf(table,after)} already exists`);
    changes.push({table,before,after});
  }
  const backup=path.join(directory,'migrations','synthetic-identifiers-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(backup,{recursive:true});
  for(const source of sourceNames)stores[source].db.prepare('VACUUM INTO ?').run(path.join(backup,`${source}_db.sqlite`));
  fs.writeFileSync(path.join(backup,'changes.json'),JSON.stringify({created_at:new Date().toISOString(),changes},null,2)+'\n');
  const mapFile=path.join(directory,'synthetic-identifiers.json');
  fs.writeFileSync(mapFile+'.tmp',JSON.stringify({version:1,synthetic:true,identifiers},null,2)+'\n');fs.renameSync(mapFile+'.tmp',mapFile);
  const db=stores.adt.db,schema=(source:SourceName)=>source==='adt'?'main':source;
  db.prepare('ATTACH DATABASE ? AS lis').run(path.join(directory,'lis_db.sqlite'));
  db.prepare('ATTACH DATABASE ? AS formulary').run(path.join(directory,'formulary_db.sqlite'));
  try{
    db.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON;');
    for(const {table,before,after}of changes){
      const prefix=schema(table.source),oldKey=keyOf(table,before),newKey=keyOf(table,after);
      // A key change must remove the former consolidated key as well as upsert
      // the replacement; the existing source outbox transports both operations.
      if(oldKey!==newKey)db.prepare(`INSERT INTO ${prefix}.events(entity,record_key,operation,payload) VALUES(?,?,'delete',?)`).run(table.name,oldKey,JSON.stringify(before));
      const fields=table.fields.map(f=>f.name).filter(k=>after[k]!==before[k]);
      db.prepare(`UPDATE ${prefix}.${table.name} SET ${fields.map(k=>`${k}=?`).join(',')},record_version=record_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${table.keys.map(k=>`${k}=?`).join(' AND ')}`).run(...fields.map(k=>after[k]??null),...table.keys.map(k=>before[k]));
      if(oldKey!==newKey)db.prepare(`UPDATE ${prefix}.request_keys SET record_key=? WHERE table_name=? AND record_key=?`).run(newKey,table.name,oldKey);
    }
    for(const source of sourceNames){const failures=db.prepare(`PRAGMA ${schema(source)}.foreign_key_check`).all();if(failures.length)throw new Error(`Identifier migration left invalid ${source} references`);}
    const unresolved=db.prepare('SELECT count(*) AS n FROM lis.cultures c LEFT JOIN main.patients p USING(patient_id) LEFT JOIN main.wards w USING(ward_code) WHERE p.patient_id IS NULL OR w.ward_code IS NULL').get() as Row;
    if(unresolved.n)throw new Error('Identifier migration left unresolved culture links');
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  finally{db.exec('DETACH DATABASE lis; DETACH DATABASE formulary;');}
  return {changed:changes.length,patients:records.patients.length,backup};
}
