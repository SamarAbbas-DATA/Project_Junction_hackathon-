import { createHash } from 'node:crypto';
import { AppError,type SourceName } from './config.js';
import { tables,keyOf,type Table } from './catalog.js';
import type { Row,SourceStore } from './source-store.js';

// A deliberately small FHIR R4 application profile. Business identifiers are
// preserved; FHIR logical IDs also work for composite keys and non-FHIR IDs.
export const profile='https://amr-hub.local/fhir';
export const system=(name:string)=>`${profile}/identifier/${name}`;
export const logicalId=(table:string,key:string)=>'r-'+createHash('sha256').update(`${table}:${key}`).digest('hex').slice(0,40);
export const resourceTypes:Record<string,string>={patients:'Patient',wards:'Location',ward_stays:'Encounter',cultures:'DiagnosticReport',specimen_types:'SpecimenDefinition',isolates:'Observation',ast_results:'Observation',antibiotics:'MedicationKnowledge',guidelines:'PlanDefinition'};
const identifier=(name:string,value:string)=>({system:system(name),value});
const ref=(table:string,key:string,idName:string)=>({reference:`${resourceTypes[table]}/${logicalId(table,key)}`,identifier:identifier(idName,key)});
const concept=(name:string,code:string,display?:string)=>({coding:[{system:`${profile}/CodeSystem/${name}`,code,...(display?{display}:{})}]});
const ext=(name:string,value:any,type='String')=>({url:`${profile}/StructureDefinition/${name}`,[`value${type}`]:value});
const extension=(resource:Row,name:string)=>resource.extension?.find((e:Row)=>e.url===`${profile}/StructureDefinition/${name}`);
const value=(resource:Row,name:string,type='String')=>extension(resource,name)?.[`value${type}`];
const idValue=(resource:Row,name:string)=>resource.identifier?.find((i:Row)=>i.system===system(name))?.value;
const refValue=(reference:Row|undefined,name:string)=>reference?.identifier?.system===system(name)?reference.identifier.value:undefined;
const code=(cc:Row|undefined)=>cc?.coding?.[0]?.code;
const label=(cc:Row|undefined)=>cc?.text||cc?.coding?.[0]?.display;
export type FhirChange={table:Table;row:Row;resource:Row;deleted:boolean;version:number};

export function encodeResource(table:Table,row:Row,version:number,reportStatus?:string):Row {
  const key=keyOf(table,row),base:Row={resourceType:resourceTypes[table.name],id:logicalId(table.name,key),meta:{versionId:String(version),lastUpdated:row.updated_at},extension:[...(row.created_at?[ext('created-at',row.created_at,'Instant')]:[]),ext('record-version',row.record_version??1,'Integer')]};
  const add=(name:string,v:any,type='String')=>{if(v!==undefined&&v!==null)base.extension.push(ext(name,v,type));};
  const patient=()=>ref('patients',row.patient_id,'patient-id');
  switch(table.name){
    case 'patients':Object.assign(base,{identifier:[identifier('patient-id',row.patient_id)],gender:row.sex==='F'?'female':'male',birthDate:String(row.birth_year),address:[{district:row.home_area}]});break;
    case 'wards':Object.assign(base,{identifier:[identifier('ward-code',row.ward_code)],name:row.ward_en,alias:[row.ward_fi],mode:'instance',type:[concept('ward-type',row.ward_type)]});add('institution',row.institution);break;
    case 'ward_stays':Object.assign(base,{identifier:[identifier('stay-id',row.stay_id)],status:'unknown',class:{system:'http://terminology.hl7.org/CodeSystem/v3-ActCode',code:'IMP'},subject:patient(),period:{start:row.admission_date},location:[{location:ref('wards',row.ward_code,'ward-code'),period:{start:row.admission_date}}]});add('stay-origin',row.origin);break;
    case 'cultures':Object.assign(base,{identifier:[identifier('culture-id',row.culture_id)],status:reportStatus||row.status,code:concept('report','culture','Microbiology culture'),subject:patient(),effectiveDateTime:row.sample_date,specimen:[{reference:`Specimen/${logicalId('specimens',row.culture_id)}`,identifier:identifier('culture-id',row.culture_id)}],...(row.result?{conclusionCode:[concept('culture-result',row.result)]}:{})});add('sample-location',ref('wards',row.ward_code,'ward-code'),'Reference');add('admission-date',row.admission_date,'Date');add('age-years',row.age_years,'Integer');add('isolate-count',row.n_isolates??0,'Integer');add('specimen-code',row.specimen);break;
    case 'specimen_types':Object.assign(base,{identifier:identifier('specimen-code',row.specimen),typeCollected:concept('specimen',row.specimen,row.specimen_fi)});break;
    case 'isolates':Object.assign(base,{identifier:[identifier('isolate-id',row.isolate_id)],status:'final',category:[concept('observation-kind','organism')],code:concept('observation','organism-identification'),valueCodeableConcept:{text:row.organism},specimen:{reference:`Specimen/${logicalId('specimens',row.culture_id)}`,identifier:identifier('culture-id',row.culture_id)}});add('isolate-number',row.isolate_no,'Integer');add('growth-quantity',row.quantity);for(const flag of ['esbl','mrsa','vre','cpe'])add(flag,!!row[flag],'Boolean');break;
    case 'ast_results':Object.assign(base,{identifier:[identifier('ast-key',key)],status:row.record_version>1?'corrected':'final',category:[concept('observation-kind','susceptibility')],code:concept('antibiotic',row.antibiotic_code),valueCodeableConcept:{coding:[{system:'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',code:row.result}]},derivedFrom:[ref('isolates',row.isolate_id,'isolate-id')]});add('interpretation-guideline',row.guideline);break;
    case 'antibiotics':Object.assign(base,{code:concept('antibiotic',row.antibiotic_code,row.antibiotic),synonym:[row.antibiotic_fi],medicineClassification:[{type:{text:'Antibiotic class'},classification:[{text:row.class}]}]});add('reported-for',row.reported_for);break;
    case 'guidelines':Object.assign(base,{identifier:[identifier('guideline-id',row.guideline)],title:row.guideline,status:'unknown',...(row.valid_from?{effectivePeriod:{start:row.valid_from}}:{})});break;
  }
  return base;
}

export function specimenResource(row:Row,version:number):Row {
  return {resourceType:'Specimen',id:logicalId('specimens',row.culture_id),meta:{versionId:String(version),lastUpdated:row.updated_at},identifier:[identifier('culture-id',row.culture_id)],subject:ref('patients',row.patient_id,'patient-id'),type:concept('specimen',row.specimen),collection:{collectedDateTime:row.sample_date}};
}

export function messageBundle(source:SourceName,id:string,sequence:number,resources:Row[],options:{deleted?:boolean;focus?:Row;bootstrap?:boolean}={}):Row {
  const focus=options.focus||resources[0];
  const header={resourceType:'MessageHeader',id:logicalId('messages',id),eventCoding:{system:`${profile}/CodeSystem/events`,code:options.bootstrap?'initial-load':options.deleted?'delete':'upsert'},source:{name:source,endpoint:`urn:amr-source:${source}`},extension:[ext('source-sequence',sequence,'Integer')],...(focus?{focus:[{reference:`${focus.resourceType}/${focus.id}`}]}:{})};
  return {resourceType:'Bundle',id:logicalId('bundles',id),identifier:identifier('message-id',id),type:'message',timestamp:new Date().toISOString(),entry:[header,...resources].map(resource=>({fullUrl:`${profile}/${resource.resourceType}/${resource.id}`,resource}))};
}

// Startup reads happen privately inside the hospital adapter, never through a
// table-transfer API. Only FHIR resources cross the intake boundary.
export function bootstrapMessages(store:SourceStore){
  const snapshot=store.snapshot(),epoch=createHash('sha256').update(JSON.stringify({source:store.source,cursor:snapshot.cursor})).digest('hex').slice(0,12);
  const snapshotTime=Object.values(snapshot.tables).flat().reduce<string>((latest,row:any)=>row.updated_at>latest?row.updated_at:latest,'1970-01-01T00:00:00Z');
  function* messages(){
    let resources:Row[]=[],page=0;
    for(const table of store.catalog)for(const row of snapshot.tables[table.name] as Row[]){
      resources.push(encodeResource(table,row,snapshot.cursor));
      if(table.name==='cultures')resources.push(specimenResource(row,snapshot.cursor));
      if(resources.length>=500){const bundle=messageBundle(store.source,`initial-${store.source}-${epoch}-${page++}`,snapshot.cursor,resources,{bootstrap:true});bundle.timestamp=snapshotTime;yield bundle;resources=[];}
    }
    if(resources.length){const bundle=messageBundle(store.source,`initial-${store.source}-${epoch}-${page}`,snapshot.cursor,resources,{bootstrap:true});bundle.timestamp=snapshotTime;yield bundle;}
  }
  return {cursor:snapshot.cursor,messages:messages()};
}

function validate(table:Table,row:Row){
  for(const field of table.fields){
    const v=row[field.name];
    if(v===undefined||v===null){if(field.required)throw new AppError(422,`${table.name}.${field.name} is required by the intake profile`);continue;}
    if(field.type?!Number.isSafeInteger(v):typeof v!=='string'||v.length>500||(field.required&&!v.trim()))throw new AppError(422,`Invalid ${table.name}.${field.name}`);
    if(field.values&&!field.values.includes(v))throw new AppError(422,`Unsupported ${table.name}.${field.name}`);
    if(field.date&&(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v))throw new AppError(422,`Invalid date in ${field.name}`);
  }
  if(table.keys.some(k=>String(row[k]).includes('~')))throw new AppError(422,'Primary IDs cannot contain ~');
  if(table.name==='patients'&&(row.birth_year<1900||row.birth_year>2100))throw new AppError(422,'Invalid birth year');
  if(table.name==='cultures'&&(row.age_years<0||row.age_years>120||row.n_isolates<0||(row.status==='final'&&!row.result)))throw new AppError(422,'Invalid culture facts');
  if(table.name==='isolates'&&row.isolate_no<1)throw new AppError(422,'Invalid isolate number');
}

export function decodeMessage(source:SourceName,bundle:Row):{id:string;sequence:number;bootstrap:boolean;changes:FhirChange[]} {
  const header=bundle?.entry?.[0]?.resource,id=bundle?.identifier?.value;
  if(bundle?.resourceType!=='Bundle'||bundle.type!=='message'||header?.resourceType!=='MessageHeader'||typeof id!=='string'||!id||id.length>200||header.source?.endpoint!==`urn:amr-source:${source}`)throw new AppError(422,'Expected a FHIR R4 message Bundle with this source and a message identifier');
  const sequence=value(header,'source-sequence','Integer'),operation=code({coding:[header.eventCoding]}),bootstrap=operation==='initial-load';
  if(!Number.isSafeInteger(sequence)||sequence<0||!['initial-load','upsert','delete'].includes(operation)||!Array.isArray(bundle.entry)||bundle.entry.length>2000)throw new AppError(422,'Invalid message sequence, event or size');
  const focus=header.focus?.[0]?.reference,changes:FhirChange[]=[],seen=new Set<string>();
  for(const {resource:r}of bundle.entry.slice(1)){
    if(!r||typeof r.id!=='string'||!/^[A-Za-z0-9.-]{1,64}$/.test(r.id))throw new AppError(422,'Every resource needs a valid FHIR logical ID');
    // These are report context, not a second source of patient demographics.
    if(r.resourceType==='Specimen'||(source==='lis'&&r.resourceType==='Patient'))continue;
    let name:string|undefined,row:Row={};
    switch(r.resourceType){
      case 'Patient':name='patients';row={patient_id:idValue(r,'patient-id'),sex:r.gender==='female'?'F':r.gender==='male'?'M':undefined,birth_year:/^\d{4}(?:-\d{2}-\d{2})?$/.test(r.birthDate||'')?Number(r.birthDate.slice(0,4)):undefined,home_area:r.address?.[0]?.district};break;
      case 'Location':name='wards';row={ward_code:idValue(r,'ward-code'),ward_en:r.name,ward_fi:r.alias?.[0],ward_type:code(r.type?.[0]),institution:value(r,'institution')};break;
      case 'Encounter':name='ward_stays';row={stay_id:idValue(r,'stay-id'),patient_id:refValue(r.subject,'patient-id'),ward_code:refValue(r.location?.[0]?.location,'ward-code'),admission_date:r.location?.[0]?.period?.start?.slice(0,10)||r.period?.start?.slice(0,10),origin:value(r,'stay-origin')};break;
      case 'DiagnosticReport':name='cultures';if(!['registered','preliminary','final','amended','corrected'].includes(r.status))throw new AppError(422,'Unsupported report status');row={culture_id:idValue(r,'culture-id'),patient_id:refValue(r.subject,'patient-id'),ward_code:refValue(value(r,'sample-location','Reference'),'ward-code'),admission_date:value(r,'admission-date','Date')??null,age_years:value(r,'age-years','Integer'),sample_date:r.effectiveDateTime?.slice(0,10),specimen:value(r,'specimen-code'),result:code(r.conclusionCode?.[0])??null,n_isolates:value(r,'isolate-count','Integer'),status:['amended','corrected'].includes(r.status)?'final':r.status};break;
      case 'SpecimenDefinition':name='specimen_types';row={specimen:r.identifier?.system===system('specimen-code')?r.identifier.value:undefined,specimen_fi:label(r.typeCollected)};break;
      case 'Observation':if(code(r.category?.[0])==='organism'){name='isolates';row={isolate_id:idValue(r,'isolate-id'),culture_id:refValue(r.specimen,'culture-id'),isolate_no:value(r,'isolate-number','Integer'),organism:label(r.valueCodeableConcept),quantity:value(r,'growth-quantity')??null,...Object.fromEntries(['esbl','mrsa','vre','cpe'].map(f=>[f,value(r,f,'Boolean')?1:0]))};}else if(code(r.category?.[0])==='susceptibility'){name='ast_results';row={isolate_id:refValue(r.derivedFrom?.[0],'isolate-id'),antibiotic_code:code(r.code),result:code(r.valueCodeableConcept),guideline:value(r,'interpretation-guideline')};}break;
      case 'MedicationKnowledge':name='antibiotics';row={antibiotic_code:code(r.code),antibiotic:label(r.code),antibiotic_fi:r.synonym?.[0],class:label(r.medicineClassification?.[0]?.classification?.[0]),reported_for:value(r,'reported-for')};break;
      case 'PlanDefinition':name='guidelines';row={guideline:idValue(r,'guideline-id'),valid_from:r.effectivePeriod?.start?.slice(0,10)??null};break;
    }
    const table=tables.find(t=>t.name===name&&t.source===source);
    if(!table)throw new AppError(422,`Resource ${r.resourceType} is not supported for ${source}`);
    validate(table,row);
    if(logicalId(table.name,keyOf(table,row))!==r.id)throw new AppError(422,'Resource ID does not match its business identifier');
    const version=Number(r.meta?.versionId);
    if(typeof r.meta?.versionId!=='string'||!/^(0|[1-9]\d*)$/.test(r.meta.versionId)||!Number.isSafeInteger(version)||version<0||!Number.isFinite(Date.parse(r.meta?.lastUpdated)))throw new AppError(422,'Resource version and lastUpdated are required');
    row.created_at=value(r,'created-at','Instant')||r.meta.lastUpdated;row.updated_at=r.meta.lastUpdated;row.record_version=value(r,'record-version','Integer')??1;
    if(!Number.isFinite(Date.parse(row.created_at)))throw new AppError(422,'Invalid creation timestamp');
    if(!Number.isSafeInteger(row.record_version)||row.record_version<1)throw new AppError(422,'Invalid source record version');
    const key=`${table.name}:${keyOf(table,row)}`;if(seen.has(key))throw new AppError(422,'Duplicate resource in message');seen.add(key);
    changes.push({table,row,resource:r,deleted:operation==='delete'&&focus===`${r.resourceType}/${r.id}`,version});
  }
  if(!changes.length||(operation==='delete'&&!changes.some(c=>c.deleted)))throw new AppError(422,'Message has no supported changes');
  return {id,sequence,bootstrap,changes};
}
