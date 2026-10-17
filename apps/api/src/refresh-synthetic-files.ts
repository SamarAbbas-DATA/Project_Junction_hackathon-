import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { tables,fieldNames } from './catalog.js';
import { root } from './config.js';
import { readDemoZip } from './demo-import.js';
import { toCsv,type DemoBatch } from './demo-data.js';

export function refreshSyntheticFiles(backup:string,output=path.join(root,'output','data')) {
  const files=path.join(backup,'files');fs.mkdirSync(files,{recursive:true});
  const contents=(batch:DemoBatch)=>{
    batch.description='Entirely synthetic hospital records. Fictional compounds and test-only interpretations; not clinical guidance.';
    const zip=new AdmZip(),counts=Object.fromEntries(tables.map(t=>[t.name,batch.tables[t.name].length]));
    const manifest=JSON.stringify({...batch,tables:undefined,counts},null,2)+'\n';zip.addFile('manifest.json',Buffer.from(manifest));
    for(const table of tables)zip.addFile(table.name+'.csv',Buffer.from(toCsv(fieldNames(table),batch.tables[table.name])));
    return {zip,manifest};
  };
  const directory=path.join(output,'synthetic_batch');
  if(fs.existsSync(path.join(directory,'manifest.json'))){
    const original=new AdmZip();original.addFile('manifest.json',fs.readFileSync(path.join(directory,'manifest.json')));
    for(const table of tables)original.addFile(table.name+'.csv',fs.readFileSync(path.join(directory,table.name+'.csv')));
    const previous=path.join(files,'synthetic_batch_before.zip');if(!fs.existsSync(previous))original.writeZip(previous);
    const batch=readDemoZip(original.toBuffer());if(batch.batch_id.startsWith('DEMO-'))throw new Error('Synthetic CSV folder could not be matched to the identifier map');
    const {manifest}=contents(batch);fs.writeFileSync(path.join(directory,'manifest.json'),manifest);
    for(const table of tables)fs.writeFileSync(path.join(directory,table.name+'.csv'),toCsv(fieldNames(table),batch.tables[table.name]));
  }
  const inbox=path.join(output,'inbox'),archives=[path.join(output,'synthetic_hospital_batch.zip'),...(fs.existsSync(inbox)?fs.readdirSync(inbox).filter(f=>f.toLowerCase().endsWith('.zip')).map(f=>path.join(inbox,f)):[])].filter(f=>fs.existsSync(f));
  for(const file of archives){
    const bytes=fs.readFileSync(file),batch=readDemoZip(bytes);if(batch.batch_id.startsWith('DEMO-'))throw new Error(`Cannot match ${path.basename(file)} to migrated records`);
    const {zip}=contents(batch),target=path.basename(file).startsWith('DEMO-')?path.join(path.dirname(file),batch.batch_id+'.zip'):file;
    const previous=path.join(files,path.basename(file));if(!fs.existsSync(previous))fs.writeFileSync(previous,bytes);
    zip.writeZip(target+'.tmp');fs.renameSync(target+'.tmp',target);
    if(target!==file)fs.unlinkSync(file);
    console.log('Updated synthetic CSV package: '+path.relative(root,target));
  }
}
