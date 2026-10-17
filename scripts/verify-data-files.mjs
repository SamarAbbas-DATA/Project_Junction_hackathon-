import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import AdmZip from 'adm-zip';
import { parse } from 'csv-parse';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'output','data');
const numeric=new Set(['birth_year','age_years','n_isolates','isolate_no','esbl','mrsa','vre','cpe','record_version']);
const dates=new Set(['admission_date','sample_date','valid_from']);
function canonical(columns,values) {
  return columns.map((name,i)=>{
    const value=values[i];
    if(value==null||value==='')return null;
    if(numeric.has(name))return Number(value);
    if(dates.has(name))return value instanceof Date?value.toISOString().slice(0,10):typeof value==='number'?new Date((value-25569)*86400000).toISOString().slice(0,10):String(value);
    return String(value);
  });
}
async function csvInfo(file) {
  const hash=createHash('sha256');let columns,rows=0;
  for await(const values of fs.createReadStream(file).pipe(parse({bom:true,skip_empty_lines:true}))) {
    if(!columns){columns=values;continue;}
    hash.update(JSON.stringify(canonical(columns,values))+'\n');rows++;
  }
  return {columns,rows,hash:hash.digest('hex')};
}
async function checkWorkbook(file,expected) {
  // The streaming reader can emit fallback names before workbook.xml arrives.
  const xml=new AdmZip(file).getEntry('xl/workbook.xml').getData().toString('utf8');
  const names=new Map([...xml.matchAll(/<sheet\s+sheetId="(\d+)"\s+name="([^"]+)"/g)].map(m=>[m[1],m[2]]));
  const small=Object.values(expected).reduce((sum,t)=>sum+t.rows,0)<=5000;
  const workbook=small?await new ExcelJS.Workbook().xlsx.readFile(file):null;
  const reader=small?workbook.worksheets:new ExcelJS.stream.xlsx.WorkbookReader(file,{worksheets:'emit',sharedStrings:'cache',styles:'cache',hyperlinks:'ignore'});
  const found=new Set();
  for await(const sheet of reader) {
    const name=names.get(String(sheet.id))||sheet.name;
    if(!expected[name])continue;
    const target=expected[name],hash=createHash('sha256');let rows=0;
    const rowsToRead=small?(function*(){for(let i=1;i<=sheet.rowCount;i++)yield sheet.getRow(i);})():sheet;
    for await(const row of rowsToRead) {
      const values=target.columns.map((_,i)=>row.getCell(i+1).value);
      if(row.number===1){if(JSON.stringify(values)!==JSON.stringify(target.columns))throw new Error(`Header mismatch in ${file}/${name}`);continue;}
      hash.update(JSON.stringify(canonical(target.columns,values))+'\n');rows++;
    }
    if(rows!==target.rows||hash.digest('hex')!==target.hash)throw new Error(`CSV/Excel data mismatch in ${file}/${name}: ${rows} rows`);
    found.add(name);console.log(`${path.basename(file)} / ${name}: ${rows.toLocaleString()} rows, every value matches CSV`);
    if(found.size===Object.keys(expected).length)break;
  }
  if(found.size!==Object.keys(expected).length)throw new Error('A requested data sheet is missing in '+file);
}
const manifest=JSON.parse(await fsp.readFile(path.join(output,'source_tables','manifest.json'),'utf8'));
for(const table of manifest.tables) {
  const info=await csvInfo(path.join(output,table.file));
  if(info.rows!==table.rows)throw new Error('Source manifest count mismatch: '+table.table);
  await checkWorkbook(path.join(output,table.table+'.xlsx'),{[table.table]:info});
}
const synthetic=JSON.parse(await fsp.readFile(path.join(output,'synthetic_batch','manifest.json'),'utf8'));
const expected={};
for(const name of Object.keys(synthetic.counts)) {
  expected[name]=await csvInfo(path.join(output,'synthetic_batch',name+'.csv'));
  if(expected[name].rows!==synthetic.counts[name])throw new Error('Synthetic manifest mismatch: '+name);
}
await checkWorkbook(path.join(output,'synthetic_hospital_batch.xlsx'),expected);
console.log('All 10 workbooks verified against their CSV data.');
