import type { SourceName } from './config.js';

export type Field = { name: string; type?: 'integer' | 'number'; required?: boolean; values?: (string | number)[]; nullable?: boolean; date?: boolean; description?: string };
export type Table = { source: SourceName; name: string; label: string; keys: string[]; fields: Field[]; search: string[]; description: string };
const text = (name: string, required = true, rest: Partial<Field> = {}): Field => ({ name, required, ...rest });
const integer = (name: string, required = true, rest: Partial<Field> = {}): Field => ({ name, required, type: 'integer', ...rest });
const date = (name: string, required = true): Field => text(name, required, { date: true, nullable: !required });
export const tables: Table[] = [
  { source:'adt', name:'patients', label:'Patients', keys:['patient_id'], search:['patient_id','home_area'], description:'Patient identity and demographic information. IDs are preserved from the supplied dataset.', fields:[text('patient_id'),text('sex',true,{values:['F','M']}),integer('birth_year'),text('home_area')] },
  { source:'adt', name:'wards', label:'Wards & care locations', keys:['ward_code'], search:['ward_code','ward_en','ward_fi'], description:'Hospital wards, emergency department and primary care locations.', fields:[text('ward_code'),text('ward_fi'),text('ward_en'),text('ward_type',true,{values:['in','out']}),text('institution',true,{values:['hospital','primary_care']})] },
  { source:'adt', name:'ward_stays', label:'Ward stays', keys:['stay_id'], search:['stay_id','patient_id','ward_code'], description:'Initial stays are distinct inpatient patient/ward/admission-date combinations derived from cultures, not verified transfer histories.', fields:[text('stay_id'),text('patient_id'),text('ward_code'),date('admission_date'),text('origin',false,{values:['derived_from_cultures','recorded']})] },
  { source:'lis', name:'cultures', label:'Cultures & samples', keys:['culture_id'], search:['culture_id','patient_id','ward_code'], description:'All samples, including negative and mixed-growth cultures. The recorded ward is the sample location, not necessarily the current patient location.', fields:[text('culture_id'),text('patient_id'),text('ward_code'),date('admission_date',false),integer('age_years'),date('sample_date'),text('specimen',true,{values:['urine','blood','wound']}),text('result',false,{nullable:true,values:['positive','negative','mixed_growth']}),integer('n_isolates',false),text('status',true,{values:['registered','preliminary','final']})] },
  { source:'lis', name:'specimen_types', label:'Specimen types', keys:['specimen'], search:['specimen','specimen_fi'], description:'Specimen codes and Finnish labels.', fields:[text('specimen'),text('specimen_fi')] },
  { source:'lis', name:'isolates', label:'Organism isolates', keys:['isolate_id'], search:['isolate_id','culture_id','organism'], description:'An organism recovered from a culture. Blood quantities can be null.', fields:[text('isolate_id'),text('culture_id'),integer('isolate_no'),text('organism'),text('quantity',false,{nullable:true}),...['esbl','mrsa','vre','cpe'].map(name=>integer(name,false,{values:[0,1]}))] },
  { source:'lis', name:'ast_results', label:'Antibiotic test results', keys:['isolate_id','antibiotic_code'], search:['isolate_id','antibiotic_code','guideline'], description:'Current S/R result for each isolate–antibiotic pair. Corrections increment the version; prior values remain in the event history.', fields:[text('isolate_id'),text('antibiotic_code'),text('result',true,{values:['S','R']}),text('guideline')] },
  { source:'formulary', name:'antibiotics', label:'Antibiotic catalogue', keys:['antibiotic_code'], search:['antibiotic_code','antibiotic','class'], description:'Antibiotic reference information, not prescriptions or medication administration.', fields:[text('antibiotic_code'),text('antibiotic'),text('antibiotic_fi'),text('class'),text('reported_for',true,{values:['all','urine']})] },
  { source:'formulary', name:'guidelines', label:'Interpretation guidelines', keys:['guideline'], search:['guideline'], description:'Guideline editions in the supplied tests. Effective dates are unknown unless explicitly entered.', fields:[text('guideline'),date('valid_from',false)] }
];
export const getTable = (source: string, name: string) => tables.find(t=>t.source===source && t.name===name);
export const keyOf = (table: Table, record: Record<string, unknown>) => table.keys.map(key=>String(record[key])).join('~');
export const fieldNames = (table: Table) => table.fields.map(f=>f.name);

export function recordSchema(table: Table, partial = false) {
  return { type:'object', additionalProperties:false, required:partial ? [] : table.fields.filter(f=>f.required).map(f=>f.name), properties:Object.fromEntries(table.fields.map(f=>[f.name, {
    type:f.nullable ? [f.type || 'string','null'] : f.type || 'string',
    ...(f.values ? {enum:f.nullable ? [...f.values,null] : f.values} : {}),
    ...(!f.type ? {maxLength:500, ...(f.required ? {minLength:1} : {})} : {}),
    ...(f.name==='age_years' ? {minimum:0,maximum:120} : {}),
    ...(f.name==='birth_year' ? {minimum:1900,maximum:2100} : {}),
    ...(f.name==='isolate_no' ? {minimum:1} : {}),
    ...(f.name==='n_isolates' ? {minimum:0} : {})
  }])) };
}
