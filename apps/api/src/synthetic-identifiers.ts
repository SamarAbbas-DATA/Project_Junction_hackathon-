import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataDir } from './config.js';
import type { Row } from './source-store.js';

export const firstSyntheticPatientId=1018112;
export const cultureIdentifier=(patient:string,date:string,visit:number)=>`MB${date.slice(2,4)}${patient}${String(visit).padStart(2,'0')}`;
export const stayIdentifier=(patient:string,ward:string,date:string)=>`WS${patient}-${ward}-${date.replaceAll('-','')}`;
export type IdentifierMap=Record<string,string>;
export function loadIdentifierMap(directory=dataDir):IdentifierMap {
  const file=path.join(directory,'synthetic-identifiers.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')).identifiers:{};
}
// Reserve ranges independently of importing a file, so generating two queued
// batches cannot assign the same patients. SQLite serializes concurrent calls.
export function reservePatientRange(count:number,directory=dataDir) {
  if(!Number.isSafeInteger(count)||count<1||count>1000)throw new Error('Invalid patient range size');
  fs.mkdirSync(directory,{recursive:true});
  const db=new DatabaseSync(path.join(directory,'synthetic-counters.sqlite'));db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY,next_id INTEGER NOT NULL);');
  let sourceMax=0;const sourceFile=path.join(directory,'adt_db.sqlite');
  if(fs.existsSync(sourceFile)){const source=new DatabaseSync(sourceFile,{readOnly:true});try{sourceMax=Number((source.prepare("SELECT coalesce(max(CAST(patient_id AS INTEGER)),0) AS n FROM patients WHERE length(patient_id)=7 AND patient_id NOT GLOB '*[^0-9]*'").get() as Row).n);}finally{source.close();}}
  try{db.exec('BEGIN IMMEDIATE');const current=db.prepare("SELECT next_id FROM counters WHERE name='patient'").get() as Row|undefined;
    const start=Math.max(firstSyntheticPatientId,sourceMax+1,current?.next_id||0);if(start+count>10000000)throw new Error('Seven-digit synthetic patient range is exhausted');
    db.prepare("INSERT INTO counters(name,next_id) VALUES('patient',?) ON CONFLICT(name) DO UPDATE SET next_id=excluded.next_id").run(start+count);db.exec('COMMIT');return start;
  }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
}
export function remapSyntheticRow(table:string,row:Row,identifiers:IdentifierMap):Row {
  const next=Object.fromEntries(Object.entries(row).map(([key,value])=>[key,typeof value==='string'?(identifiers[value]||value):value]));
  const legacy=Object.values(row).some(value=>typeof value==='string'&&value.startsWith('DEMO-'));
  if(legacy&&table==='patients')next.home_area=String(next.home_area).replace(/^Demo\s*\/\s*/i,'');
  if(legacy&&table==='wards'){
    const number=String(next.ward_code).split('-').at(-1);
    next.ward_en=String(next.ward_en).replace(/^Demo\s+/i,'').replace(/^./,s=>s.toUpperCase())+` ${Number(number)}`;
    next.ward_fi=String(next.ward_fi).replace(/^Demo\s+/i,'')+` ${Number(number)}`;
  }
  if(legacy&&table==='antibiotics'&&/^SYN-\d+$/.test(next.antibiotic_code)){
    const n=Number(next.antibiotic_code.slice(4));next.antibiotic=`Synthetic compound ${n}`;next.antibiotic_fi=`Synteettinen yhdiste ${n}`;next.class='synthetic_reference';
  }
  return next;
}
