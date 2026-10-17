import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import AdmZip from 'adm-zip';
import { tables, fieldNames } from './catalog.js';
import { dataDir, root, sourceNames } from './config.js';
import { generateDemoBatch, toCsv, validateDemoBatch } from './demo-data.js';
import { reservePatientRange } from './synthetic-identifiers.js';

const output=path.join(root,'output','data');
fs.mkdirSync(output,{recursive:true});
if(process.argv.includes('--generate')) {
  const arg=(name:string)=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
  const count=Number(arg('--patients')||50);
  const batch=generateDemoBatch(count,arg('--date'),reservePatientRange(count));
  validateDemoBatch(batch);
  const directory=path.join(output,'synthetic_batch');fs.mkdirSync(directory,{recursive:true});
  const zip=new AdmZip();
  const counts:Record<string,number>={};
  for(const table of tables) {
    const csv=toCsv(fieldNames(table),batch.tables[table.name]);
    fs.writeFileSync(path.join(directory,table.name+'.csv'),csv);
    zip.addFile(table.name+'.csv',Buffer.from(csv));counts[table.name]=batch.tables[table.name].length;
  }
  const manifest={...batch,tables:undefined,counts};
  const json=JSON.stringify(manifest,null,2)+'\n';
  fs.writeFileSync(path.join(directory,'manifest.json'),json);zip.addFile('manifest.json',Buffer.from(json));
  const target=arg('--output')?path.resolve(arg('--output')!):process.argv.includes('--inbox')?path.join(output,'inbox',batch.batch_id+'.zip'):path.join(output,'synthetic_hospital_batch.zip');
  fs.mkdirSync(path.dirname(target),{recursive:true});
  // Publish the complete ZIP atomically so a running watcher never reads half a file.
  zip.writeZip(target+'.tmp');fs.renameSync(target+'.tmp',target);
  console.log(JSON.stringify({file:target,batch_id:batch.batch_id,counts},null,2));
} else {
  const manifest:{exported_at:string;tables:unknown[]}={exported_at:new Date().toISOString(),tables:[]};
  for(const source of sourceNames) {
    const db=new DatabaseSync(path.join(dataDir,`${source}_db.sqlite`),{readOnly:true});
    try {
      db.exec('BEGIN');
      for(const table of tables.filter(t=>t.source===source)) {
        const columns=[...fieldNames(table),'created_at','updated_at','record_version'];
        const rows=db.prepare(`SELECT ${columns.join(',')} FROM ${table.name} ORDER BY ${table.keys.join(',')}`).all();
        const directory=path.join(output,'source_tables',source);fs.mkdirSync(directory,{recursive:true});
        const file=path.join(directory,table.name+'.csv');fs.writeFileSync(file,toCsv(columns,rows));
        manifest.tables.push({source,table:table.name,rows:rows.length,columns,file:path.relative(output,file).replaceAll('\\','/'),database:`${source}_db.sqlite`});
        console.log(`${source}.${table.name}: ${rows.length.toLocaleString()} rows`);
      }
      db.exec('COMMIT');
    } finally {db.close();}
  }
  fs.writeFileSync(path.join(output,'source_tables','manifest.json'),JSON.stringify(manifest,null,2)+'\n');
}
