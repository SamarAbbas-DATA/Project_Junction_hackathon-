import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { AppError, root } from './config.js';
import type { HubStore } from './hub-store.js';
import type { Row } from './source-store.js';

export class Predictor {
  private active=0;
  private cached?:{signature:string;value:Row};
  constructor(private python=process.env.PYTHON_BIN||(process.platform==='win32'?'python':'python3')){}
  async call(action:string,inputs?:Row):Promise<Row> {
    if(this.active>=4)throw new AppError(429,'The predictor is busy. Try again shortly.');
    this.active++;
    try{return await new Promise((resolve,reject)=>{
      const child=execFile(this.python,['-u',path.join(root,'AMR','dashboard_bridge.py')],{cwd:root,windowsHide:true,timeout:15000,maxBuffer:4*1024*1024,env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'}},(error,stdout)=>{
        let output:Row|undefined;try{output=JSON.parse(stdout);}catch{}
        if(error||!output||output.error)return reject(new AppError(503,output?.error?`Prediction model: ${output.error}`:'The Python predictor could not run. Install Python 3.8+ or set PYTHON_BIN in .env.'));
        resolve(output);
      });
      child.stdin?.on('error',()=>{});child.stdin?.end(JSON.stringify({action,inputs}));
    });}finally{this.active--;}
  }
  async metadata() {
    let signature:string;
    try{signature=(await Promise.all(['amr_model.json','amr_predict.py','demo/server.py'].map(f=>stat(path.join(root,'AMR','model',f))))).map(s=>`${s.size}:${s.mtimeMs}`).join('|');}
    catch{throw new AppError(503,'The supplied model files are missing from AMR/model');}
    if(this.cached?.signature===signature)return this.cached.value;
    const value=await this.call('meta');this.cached={signature,value};return value;
  }
}

const codeMap:Record<string,string>={AMP:'Ampicillin',TZP:'Piperacillin/Tazobactam',CXM:'Cefuroxime',CRO:'Ceftriaxone',CAZ:'Ceftazidime',MEM:'Meropenem',CIP:'Ciprofloxacin',NIT:'Nitrofurantoin',VAN:'Vancomycin',CLI:'Clindamycin'};
export function mappedDrug(row:Row,meta:Row) {
  if(['TMP','MEC','FOX'].includes(row.antibiotic_code)||/^(DEMO-|SYN-)/.test(String(row.antibiotic_code))||/screen|synthetic (?:demo|compound)/i.test(row.antibiotic||''))return undefined;
  const name=Object.keys(meta.antibiotics).find(a=>a.toLowerCase()===String(row.antibiotic||'').toLowerCase())||codeMap[row.antibiotic_code];
  return name&&meta.antibiotics[name]?name:undefined;
}
export function mappedOrganism(value:string,meta:Row) {
  return meta.organisms.find((o:string)=>o.toLowerCase()===String(value).toLowerCase())||(value==='Enterococcus faecalis'?'Enterococcus (faecalis/spp.)':undefined);
}
export function patientInputs(history:Row,meta:Row,cultureId?:string) {
  const sample=cultureId?history.cultures.find((c:Row)=>c.culture_id===cultureId):history.cultures[0];
  if(cultureId&&!sample)throw new AppError(404,'Sample does not belong to this patient');
  const date=sample?.sample_date||new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const prior_results:Row[]=[],prior_organisms:Row[]=[],unmapped=new Set<string>();
  for(const c of history.cultures) {
    const days=(Date.parse(date+'T00:00:00Z')-Date.parse(c.sample_date+'T00:00:00Z'))/86400000;
    if(c.culture_id===sample?.culture_id||c.status!=='final'||days<3)continue;
    for(const i of c.isolates) {
      const organism=mappedOrganism(i.organism,meta);if(!organism){unmapped.add(i.organism);continue;}
      prior_organisms.push({organism,days_ago:days});
      for(const test of i.ast_results){const antibiotic=mappedDrug(test,meta);if(antibiotic&&['S','R'].includes(test.result))prior_results.push({antibiotic,organism,result:test.result,days_ago:days});else unmapped.add(test.antibiotic||test.antibiotic_code);}
    }
  }
  const isolates=(sample?.isolates||[]).map((i:Row)=>{
    const organism=mappedOrganism(i.organism,meta),known_results:Row={};
    for(const test of i.ast_results){const drug=mappedDrug(test,meta);if(drug&&organism&&meta.pairs[organism]?.includes(drug)&&meta.antibiotics[drug].specimens.includes(sample.specimen))known_results[drug]=test.result;else unmapped.add(test.antibiotic||test.antibiotic_code);}
    return {isolate_id:i.isolate_id,source_organism:i.organism,organism:organism||'',known_results,flags:Object.fromEntries(['mrsa','vre','esbl'].filter(f=>i[f]===1).map(f=>[f,true]))};
  });
  return {patient:history.patient,as_of_date:date,sample_id:sample?.culture_id||null,age_is_approximate:!sample,
    cases:history.cultures.map((c:Row)=>({culture_id:c.culture_id,sample_date:c.sample_date,specimen:c.specimen,ward_en:c.ward_en||c.ward_code})),isolates,
    inputs:{age:sample?.age_years??Number(date.slice(0,4))-history.patient.birth_year,specimen:sample?.specimen||'urine',setting:/^ICU(?:-|$)/.test(sample?.ward_code||'')?'icu':/^ED(?:-|$)/.test(sample?.ward_code||'')?'emergency':sample?.ward_type==='in'?'inpatient':'outpatient',organism:isolates[0]?.organism||'',known_results:isolates[0]?.known_results||{},flags:isolates[0]?.flags||{},history:{prior_results,prior_organisms,prior_antibiotics:[]}},
    unmapped:[...unmapped],notes:['History uses final samples collected at least 3 days earlier; historical result-release times are unavailable.','Medication exposure and nursing-home visits are not supplied by the source databases.','Trimethoprim is not TMP/SMX; cefoxitin screening and fictional drugs are excluded. Enterococcus faecalis maps to the broader model group. CPE is not converted to CRE.']};
}

const short={type:'string',minLength:1,maxLength:150};
const prior={type:'array',maxItems:5000,items:{type:'object',additionalProperties:false,required:['antibiotic','organism','result','days_ago'],properties:{antibiotic:short,organism:short,result:{enum:['S','R']},days_ago:{type:'integer',minimum:1,maximum:100000}}}};
const inputProperties={specimen:{enum:['urine','blood','respiratory']},setting:{enum:['outpatient','emergency','inpatient','icu']},age:{type:'number',minimum:18,maximum:120},organism:{type:'string',maxLength:150},
  known_results:{type:'object',maxProperties:60,additionalProperties:{enum:['S','R','I']}},flags:{type:'object',additionalProperties:false,properties:Object.fromEntries(['mrsa','vre','cre','esbl','mucoid','cf'].map(f=>[f,{type:'boolean'}]))},
  history:{type:'object',additionalProperties:false,properties:{prior_results:prior,prior_organisms:{type:'array',maxItems:5000,items:{type:'object',additionalProperties:false,required:['organism','days_ago'],properties:{organism:short,days_ago:{type:'integer',minimum:1,maximum:100000}}}},prior_antibiotics:{type:'array',maxItems:1000,items:{type:'object',additionalProperties:false,required:['drug','days_ago'],properties:{drug:short,days_ago:{type:'integer',minimum:1,maximum:100000}}}},nursing_home:{type:'boolean'}}}};
export function registerPredictor(app:FastifyInstance,hub:Pick<HubStore,'patientHistory'>,model=new Predictor()) {
  async function validate(inputs:Row,explanation=false) {
    const meta=await model.metadata();
    if(inputs.organism&&!meta.organisms.includes(inputs.organism))throw new AppError(422,'Unsupported organism');
    const known=Object.keys(inputs.known_results||{});
    if(known.length&&!inputs.organism)throw new AppError(422,'An organism is required for known laboratory results');
    if(known.some(a=>!meta.pairs[inputs.organism]?.includes(a)||!meta.antibiotics[a].specimens.includes(inputs.specimen)))throw new AppError(422,'Known result does not match a modelled organism, antibiotic and specimen');
    for(const r of inputs.history?.prior_results||[])if(!meta.antibiotics[r.antibiotic]||!meta.organisms.includes(r.organism))throw new AppError(422,'Unsupported prior laboratory result');
    for(const r of inputs.history?.prior_organisms||[])if(!meta.organisms.includes(r.organism))throw new AppError(422,'Unsupported prior organism');
    for(const r of inputs.history?.prior_antibiotics||[])if(!meta.drugs.includes(r.drug))throw new AppError(422,'Unsupported prior medication name');
    if(explanation&&(!inputs.organism||!meta.pairs[inputs.organism]?.includes(inputs.antibiotic)||!meta.antibiotics[inputs.antibiotic]?.specimens.includes(inputs.specimen)))throw new AppError(422,'Explanation is unavailable for this organism, antibiotic and specimen');
    return meta;
  }
  app.get('/api/predictor/meta',async()=>model.metadata());
  app.get('/api/predictor/patients/:id',{schema:{params:{type:'object',required:['id'],properties:{id:short}},querystring:{type:'object',additionalProperties:false,properties:{culture_id:short}}}},async request=>{
    const [history,meta]=await Promise.all([hub.patientHistory((request.params as Row).id),model.metadata()]);if(!history)throw new AppError(404,'Patient not found');
    return patientInputs(history,meta,(request.query as Row).culture_id);
  });
  app.post('/api/predictor/predict',{schema:{body:{type:'object',additionalProperties:false,required:['specimen','setting','age'],properties:inputProperties}}},async request=>{
    const inputs=request.body as Row,meta=await validate(inputs);return {...await model.call('predict',inputs),model_id:meta.model_id,generated_at:new Date().toISOString()};
  });
  app.post('/api/predictor/explain',{schema:{body:{type:'object',additionalProperties:false,required:['specimen','setting','age','organism','antibiotic'],properties:{...inputProperties,antibiotic:short}}}},async request=>{await validate(request.body as Row,true);return model.call('explain',request.body as Row);});
}
