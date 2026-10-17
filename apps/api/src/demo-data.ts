import { randomUUID } from 'node:crypto';
import { tables, fieldNames, keyOf } from './catalog.js';
import { AppError } from './config.js';
import type { Row } from './source-store.js';
import { cultureIdentifier,stayIdentifier,firstSyntheticPatientId } from './synthetic-identifiers.js';

export type DemoBatch = {
  format: 'amr-csv-batch/v1';
  batch_id: string;
  created_at: string;
  sample_date: string;
  synthetic: true;
  description: string;
  tables: Record<string, Row[]>;
};
export const importOrder = ['patients','wards','ward_stays','antibiotics','guidelines','specimen_types','cultures','isolates','ast_results'];
export const csvCell = (value: unknown) => {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"','""') + '"' : text;
};
export function toCsv(columns: string[], rows: Row[]) {
  return '\uFEFF' + [columns.join(','), ...rows.map(row => columns.map(c => csvCell(row[c])).join(','))].join('\r\n') + '\r\n';
}
export function validDate(value: string) {
  const date = new Date(value + 'T00:00:00Z');
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.valueOf()) && date.toISOString().slice(0,10) === value;
}
export function localDemoDate() {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
}
const previousDate = (date: string, days: number) => new Date(Date.parse(date+'T00:00:00Z') - days*86400000).toISOString().slice(0,10);

let nextGeneratedPatient=firstSyntheticPatientId;
export function generateDemoBatch(count=50, sampleDate=localDemoDate(),patientStart?:number): DemoBatch {
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new AppError(400,'Patient count must be between 1 and 1000');
  if (!validDate(sampleDate) || Number(sampleDate.slice(0,4)) < 2000 || Number(sampleDate.slice(0,4)) > 2100) throw new AppError(400,'Use a sample date between 2000-01-01 and 2100-12-31');
  const start=patientStart??nextGeneratedPatient;
  if(!Number.isSafeInteger(start)||start<1000000||start+count>10000000)throw new AppError(400,'Use an available seven-digit patient ID range');
  nextGeneratedPatient=Math.max(nextGeneratedPatient,start+count);
  const id = `BATCH-${sampleDate.replaceAll('-','')}-${randomUUID().slice(0,8)}`;
  const data: Record<string,Row[]> = Object.fromEntries(tables.map(t=>[t.name,[]]));
  data.wards = [
    {ward_code:'MED-02',ward_fi:'sisätaudit 2',ward_en:'Medical ward 2',ward_type:'in',institution:'hospital'},
    {ward_code:'ED-02',ward_fi:'päivystys 2',ward_en:'Emergency department 2',ward_type:'out',institution:'hospital'},
    {ward_code:'SURG-02',ward_fi:'kirurgia 2',ward_en:'Surgical ward 2',ward_type:'in',institution:'hospital'}
  ];
  data.antibiotics = [1,2,3].map(n=>({antibiotic_code:`SYN-${String(n).padStart(3,'0')}`,antibiotic:`Synthetic compound ${n}`,antibiotic_fi:`Synteettinen yhdiste ${n}`,class:'synthetic_reference',reported_for:n===3?'urine':'all'}));
  data.guidelines = [{guideline:`SYN-${sampleDate.replaceAll('-','')}`,valid_from:sampleDate}];
  data.specimen_types = [{specimen:'urine',specimen_fi:'virtsa'},{specimen:'blood',specimen_fi:'veri'},{specimen:'wound',specimen_fi:'haava'}];
  const stays = new Set<string>();
  for (let n=0;n<count;n++) {
    const patient_id = String(start+n);
    const age = 18 + (n*7)%70;
    const birth_year = Number(sampleDate.slice(0,4))-age;
    data.patients.push({patient_id,sex:n%2?'M':'F',birth_year,home_area:['North','South','East','West'][n%4]});
    // Every tenth patient has no samples; some others have a repeat sample.
    if(n%10===0) continue;
    const sampleCount = n%5===0 ? 2 : 1;
    for(let visit=0;visit<sampleCount;visit++) {
      const date = previousDate(sampleDate,visit);
      const culture_id = cultureIdentifier(patient_id,date,visit+1);
      const ward = data.wards[(n+visit)%data.wards.length];
      const admission_date = ward.ward_type==='in' ? previousDate(date,1) : null;
      const specimen = data.specimen_types[(n+visit)%3].specimen;
      const pending = n%5===1, negative = n%5===2;
      const n_isolates = pending || negative ? 0 : n%7===0 ? 2 : 1;
      data.cultures.push({culture_id,patient_id,ward_code:ward.ward_code,admission_date,age_years:Number(date.slice(0,4))-birth_year,sample_date:date,specimen,result:pending?null:negative?'negative':'positive',n_isolates,status:pending?'registered':'final'});
      if(admission_date) {
        const key=[patient_id,ward.ward_code,admission_date].join('|');
        if(!stays.has(key)) {stays.add(key);data.ward_stays.push({stay_id:stayIdentifier(patient_id,ward.ward_code,admission_date),patient_id,ward_code:ward.ward_code,admission_date,origin:'recorded'});}
      }
      for(let i=1;i<=n_isolates;i++) {
        const isolate_id = `${culture_id}-${i}`;
        data.isolates.push({isolate_id,culture_id,isolate_no:i,organism:['Escherichia coli','Klebsiella pneumoniae','Staphylococcus aureus'][(n+i-1)%3],quantity:specimen==='blood'?null:'10^5',esbl:0,mrsa:0,vre:0,cpe:0});
        for(const [a,antibiotic] of data.antibiotics.entries()) {
          if(antibiotic.reported_for==='urine' && specimen!=='urine') continue;
          data.ast_results.push({isolate_id,antibiotic_code:antibiotic.antibiotic_code,result:(n+i+a)%5===0?'R':'S',guideline:data.guidelines[0].guideline});
        }
      }
    }
  }
  return {format:'amr-csv-batch/v1',batch_id:id,created_at:new Date().toISOString(),sample_date:sampleDate,synthetic:true,description:'Entirely synthetic hospital records. Fictional compounds and test-only interpretations; not clinical guidance.',tables:data};
}

export function validateDemoBatch(batch: DemoBatch) {
  if(batch?.format!=='amr-csv-batch/v1' || batch.synthetic!==true || !/^(?:DEMO|BATCH)-[A-Za-z0-9-]+$/.test(batch.batch_id||'') || !batch.tables) throw new AppError(400,'Not a supported synthetic CSV batch');
  let total=0;
  for(const table of tables) {
    const rows=batch.tables[table.name];
    if(!Array.isArray(rows)) throw new AppError(400,`Missing ${table.name}.csv`);
    total+=rows.length;
    const keys=new Set<string>();
    for(const row of rows) {
      if(!row || typeof row!=='object' || Array.isArray(row)) throw new AppError(400,`Invalid row in ${table.name}`);
      if(Object.keys(row).some(k=>!fieldNames(table).includes(k))) throw new AppError(400,`Unexpected column in ${table.name}`);
      for(const f of table.fields) {
        const value=row[f.name];
        if(value==null) {if(f.required)throw new AppError(400,`${table.name}.${f.name} is required`);continue;}
        if(f.type ? !Number.isSafeInteger(value) : typeof value!=='string') throw new AppError(400,`Invalid type: ${table.name}.${f.name}`);
        if(typeof value==='string' && (value.length>500 || (f.required&&!value.trim()))) throw new AppError(400,`Invalid value: ${table.name}.${f.name}`);
        if(f.values&&!f.values.includes(value)) throw new AppError(400,`Invalid category: ${table.name}.${f.name}`);
        if(f.date&&!validDate(value)) throw new AppError(400,`Invalid date: ${table.name}.${f.name}`);
      }
      const key=keyOf(table,row);
      if(keys.has(key)) throw new AppError(400,`Duplicate key in ${table.name}: ${key}`);
      keys.add(key);
      if(batch.batch_id.startsWith('DEMO-')&&table.name!=='specimen_types'&&!key.startsWith(batch.batch_id+'-'))throw new AppError(400,`${table.name} identifiers must start with ${batch.batch_id}-`);
      if(batch.batch_id.startsWith('BATCH-')){
        const valid=table.name==='patients'?/^\d{7}$/.test(row.patient_id):table.name==='cultures'?/^MB\d{11,}$/.test(row.culture_id):table.name==='isolates'?/^MB\d{11,}-\d+$/.test(row.isolate_id):table.name==='ward_stays'?/^WS\d{7}-[A-Z]+-\d{2}-\d{8}$/.test(row.stay_id):table.name==='wards'?/^[A-Z]+-\d{2}$/.test(row.ward_code):table.name==='antibiotics'?/^SYN-\d{3,}$/.test(row.antibiotic_code):table.name==='guidelines'?/^SYN-\d{8}(?:-\d+)?$/.test(row.guideline):true;
        if(!valid)throw new AppError(400,`Invalid hospital-style identifier in ${table.name}: ${key}`);
      }
    }
  }
  if(total>50000) throw new AppError(400,'Batch exceeds 50,000 records');
  const index=(name:string,key:string)=>new Map(batch.tables[name].map(row=>[row[key],row]));
  const patients=index('patients','patient_id'),wards=index('wards','ward_code'),cultures=index('cultures','culture_id'),isolates=index('isolates','isolate_id');
  const drugs=index('antibiotics','antibiotic_code'),guidelines=index('guidelines','guideline'),specimens=index('specimen_types','specimen');
  for(const stay of batch.tables.ward_stays) {
    if(!patients.has(stay.patient_id)||wards.get(stay.ward_code)?.ward_type!=='in')throw new AppError(400,`Invalid patient or inpatient ward for ${stay.stay_id}`);
  }
  for(const culture of batch.tables.cultures) {
    const patient=patients.get(culture.patient_id),ward=wards.get(culture.ward_code);
    if(!patient||!ward||!specimens.has(culture.specimen))throw new AppError(400,`Missing reference for ${culture.culture_id}`);
    if(culture.age_years<0||culture.age_years>120||Math.abs(Number(culture.sample_date.slice(0,4))-patient.birth_year-culture.age_years)>1)throw new AppError(400,`Invalid age for ${culture.culture_id}`);
    if((ward.ward_type==='in'&&!culture.admission_date)||(ward.ward_type==='out'&&culture.admission_date)||(culture.admission_date&&culture.admission_date>culture.sample_date))throw new AppError(400,`Invalid admission date for ${culture.culture_id}`);
    const children=batch.tables.isolates.filter(i=>i.culture_id===culture.culture_id);
    if(culture.n_isolates!==children.length)throw new AppError(400,`Isolate count differs for ${culture.culture_id}`);
    if((children.length&&culture.result!=='positive')||(culture.status==='final'&&!culture.result))throw new AppError(400,`Invalid culture result for ${culture.culture_id}`);
  }
  const positions=new Set<string>();
  for(const isolate of batch.tables.isolates) {
    const position=`${isolate.culture_id}~${isolate.isolate_no}`;
    if(!cultures.has(isolate.culture_id)||isolate.isolate_no<1||positions.has(position))throw new AppError(400,`Invalid or duplicate isolate position for ${isolate.isolate_id}`);
    positions.add(position);
  }
  for(const test of batch.tables.ast_results) {
    const isolate=isolates.get(test.isolate_id),drug=drugs.get(test.antibiotic_code);
    if(!isolate||!drug||!guidelines.has(test.guideline))throw new AppError(400,`Missing reference for ${test.isolate_id} / ${test.antibiotic_code}`);
    if(drug.reported_for==='urine'&&cultures.get(isolate.culture_id)?.specimen!=='urine')throw new AppError(400,'Urine-only antibiotic attached to a different specimen');
  }
}
