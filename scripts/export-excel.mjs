import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse';

// Excel is a review copy. The matching UTF-8 CSVs remain the interchange data.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'output','data');
const numeric=new Set(['birth_year','age_years','n_isolates','isolate_no','esbl','mrsa','vre','cpe','record_version']);
const dates=new Set(['admission_date','sample_date','valid_from']);
const widths={patient_id:38,culture_id:42,isolate_id:47,stay_id:47,ward_code:37,antibiotic_code:37,guideline:43,organism:30,home_area:22,ward_en:31,ward_fi:30,antibiotic:63,antibiotic_fi:39,created_at:29,updated_at:29};
function column(name) {
  return {header:name,key:name,width:widths[name]||Math.max(16,name.length+3),style:{font:{name:'Aptos',size:11},numFmt:numeric.has(name)?'0':dates.has(name)?'yyyy-mm-dd':'@'}};
}
async function addCsv(workbook,name,csvFile) {
  const sheet=workbook.addWorksheet(name,{views:[{state:'frozen',ySplit:1,showGridLines:false}],properties:{defaultRowHeight:20}});
  let columns,rows=0;
  const parser=fs.createReadStream(csvFile).pipe(parse({bom:true,skip_empty_lines:true}));
  for await(const values of parser) {
    if(!columns) {
      columns=values;sheet.columns=columns.map(column);
      const header=sheet.getRow(1);header.height=29;
      header.eachCell(cell=>{cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF174F52'}};cell.font={name:'Aptos',size:11,bold:true,color:{argb:'FFFFFFFF'}};cell.alignment={vertical:'middle'};});
      header.commit();continue;
    }
    const converted=values.map((value,index)=>value===''?null:numeric.has(columns[index])?Number(value):dates.has(columns[index])?new Date(value+'T00:00:00Z'):value);
    const row=sheet.addRow(converted);
    if(rows%2===0)row.eachCell(cell=>{cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF2F7F7'}};});
    row.commit();rows++;
  }
  sheet.autoFilter={from:{row:1,column:1},to:{row:rows+1,column:columns.length}};
  sheet.commit();return rows;
}
function notes(workbook,title,entries) {
  const sheet=workbook.addWorksheet('Readme',{views:[{showGridLines:false}]});
  sheet.columns=[{width:27},{width:110}];
  const titleRow=sheet.addRow([title]);titleRow.height=30;
  titleRow.getCell(1).font={name:'Aptos',size:16,bold:true,color:{argb:'FF174F52'}};titleRow.commit();
  for(const [label,value] of entries){const row=sheet.addRow([label,value]);row.height=34;row.getCell(1).font={name:'Aptos',size:11,bold:true};row.getCell(2).font={name:'Aptos',size:11};row.getCell(2).alignment={wrapText:true,vertical:'middle'};row.commit();}
  sheet.commit();
}
async function createFile(target,build) {
  const workbook=new ExcelJS.stream.xlsx.WorkbookWriter({filename:target+'.tmp',useStyles:true,useSharedStrings:false});
  workbook.creator='AMR Hub';workbook.created=new Date();
  await build(workbook);await workbook.commit();await fsp.rename(target+'.tmp',target);
  console.log('Excel: '+path.relative(root,target));
}
if(!process.argv.includes('--synthetic-only')) {
  const manifest=JSON.parse(await fsp.readFile(path.join(output,'source_tables','manifest.json'),'utf8'));
  for(const table of manifest.tables) {
    await createFile(path.join(output,table.table+'.xlsx'),async workbook=>{
      const rows=await addCsv(workbook,table.table,path.join(output,table.file));
      if(rows!==table.rows)throw new Error('Row count mismatch: '+table.table);
      notes(workbook,table.table+' source snapshot',[
        ['Source database',table.database],['Source table',table.source+'.'+table.table],['CSV copy',table.file],['Snapshot time (UTC)',manifest.exported_at],['Rows',String(rows)],
        ['Keys',table.table==='ast_results'?'isolate_id + antibiotic_code':'See the source table schema in the application API docs.'],
        ['Null convention','Blank cells represent null or unavailable values. IDs are text; dates and counts are typed in Excel.'],
        ['Data origin','Supplied synthetic hospital dataset and current source database records. Not real patient information.'],
        ['Join path','patients.patient_id → cultures.patient_id; cultures.culture_id → isolates.culture_id; isolates.isolate_id → ast_results.isolate_id.'],
        ['Source notes',table.table==='ward_stays'?'origin=derived_from_cultures means a distinct sample-derived stay reference, not verified patient movements.':table.table==='antibiotics'?'Antibiotic reference catalogue; these records are not prescriptions or administrations.':'Metadata creation/update times describe source records, not historical clinical release times.']
      ]);
    });
  }
}
const syntheticDirectory=path.join(output,'synthetic_batch');
if(fs.existsSync(path.join(syntheticDirectory,'manifest.json'))) {
  const manifest=JSON.parse(await fsp.readFile(path.join(syntheticDirectory,'manifest.json'),'utf8'));
  await createFile(path.join(output,'synthetic_hospital_batch.xlsx'),async workbook=>{
    notes(workbook,'Synthetic hospital import batch',[
      ['Batch ID',manifest.batch_id],['Sample date',manifest.sample_date],['Patient count',String(manifest.counts.patients)],['Import package','synthetic_hospital_batch.zip: nine CSV tables and manifest.json'],
      ['Automatic import','While the app is running, place the ZIP in output/data/inbox. Import receipts are stored in data/demo-imports.'],
      ['CSV format','XLSX is an Excel review copy, not a CSV. Matching actual UTF-8 CSVs are in output/data/synthetic_batch.'],
      ['Editing','Edit the CSVs, keep column names and foreign keys intact, then ZIP the nine CSV files with manifest.json at the ZIP root.'],
      ['Demonstration scope','New patients, patients without samples, pending samples, completed cultures, multiple isolates, S/R tests, new wards and fictional drugs.'],
      ['Synthetic drugs',manifest.description],['Repeat imports','The same ZIP is imported once. Existing matching records are reused; differing source values are preserved and reported as conflicts.']
    ]);
    for(const name of Object.keys(manifest.counts)) {
      const count=await addCsv(workbook,name,path.join(syntheticDirectory,name+'.csv'));
      if(count!==manifest.counts[name])throw new Error('Synthetic row count mismatch: '+name);
    }
  });
}
