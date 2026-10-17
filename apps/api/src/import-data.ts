import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';
import { root } from './config.js';
import { tables, fieldNames } from './catalog.js';
import type { SourceStore, Row } from './source-store.js';

function load(name:string):Row[] {
  const candidates=[process.env.CSV_DIR,path.join(root,'data','raw'),path.join(root,'tmp','microbiology_merge','source')].filter(Boolean) as string[];
  const dir=candidates.find(d=>fs.existsSync(path.join(d,`${name}.csv`)));
  let content:string;
  if(dir)content=fs.readFileSync(path.join(dir,`${name}.csv`),'utf8');
  else {
    const zipPath=process.env.DATASET_ZIP || path.resolve(root,'..','synthetic_microbiology_dataset.zip');
    if(!fs.existsSync(zipPath))throw new Error('Dataset not found. Set CSV_DIR or DATASET_ZIP in .env.');
    const zip=new AdmZip(zipPath), entry=zip.getEntries().find(e=>e.entryName.endsWith(`/${name}.csv`)||e.entryName===`${name}.csv`);
    if(!entry)throw new Error(`Missing ${name}.csv in supplied ZIP`);
    content=entry.getData().toString('utf8');
  }
  return parse(content,{columns:true,bom:true,skip_empty_lines:true});
}
export function importData(stores:Record<string,SourceStore>) {
  if(Object.values(stores).every(s=>s.db.prepare("SELECT value FROM import_metadata WHERE key='seed_complete'").get()))return;
  const patients=load('patients'),wards=load('wards'),cultures=load('cultures'),isolates=load('isolates'),ast=load('susceptibility'),antibiotics=load('antibiotics');
  const stays=new Map<string,Row>(),specimens=new Map<string,Row>();
  for(const c of cultures){
    specimens.set(c.specimen,{specimen:c.specimen,specimen_fi:c.specimen_fi});
    if(c.ward_type==='in'){
      const key=[c.patient_id,c.ward_code,c.admission_date].join('|');
      stays.set(key,{stay_id:`STAY-${c.patient_id}-${c.ward_code}-${c.admission_date}`,patient_id:c.patient_id,ward_code:c.ward_code,admission_date:c.admission_date,origin:'derived_from_cultures'});
    }
  }
  const datasets:Record<string,Row[]>={patients,wards,ward_stays:[...stays.values()],specimen_types:[...specimens.values()],
    cultures:cultures.map(c=>({...c,status:'final'})),isolates,ast_results:ast,antibiotics,
    guidelines:[...new Set(ast.map(r=>r.guideline))].sort().map(guideline=>({guideline,valid_from:null}))};
  for(const source of ['adt','formulary','lis']){
    const store=stores[source];
    if(store.db.prepare("SELECT value FROM import_metadata WHERE key='seed_complete'").get())continue;
    console.log(`Importing ${source} source…`);
    store.transaction(()=>{
      const order=source==='lis'?['specimen_types','cultures','isolates','ast_results']:store.catalog.map(t=>t.name);
      for(const name of order){
        const table=tables.find(t=>t.name===name)!,fields=fieldNames(table);
        const stmt=store.db.prepare(`INSERT INTO ${name} (${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`);
        for(const row of datasets[name])stmt.run(...table.fields.map(f=>{
          const value=row[f.name]; if(value===undefined||value===null||value==='')return null;
          return f.type ? Number(value):value;
        }));
        console.log(`  ${name}: ${datasets[name].length.toLocaleString()}`);
      }
      store.db.prepare("INSERT INTO import_metadata(key,value) VALUES('seed_complete',?)").run(new Date().toISOString());
    });
  }
}
