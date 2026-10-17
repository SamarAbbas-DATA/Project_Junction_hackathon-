import { createHash } from 'node:crypto';
import { AppError } from './config.js';
import type { HubStore } from './hub-store.js';
import { Predictor,patientInputs } from './predictor.js';
import type { Row } from './source-store.js';

export type AssistantMode='patient'|'culture'|'ward'|'general';
export type Focus={patient_ids?:string[];culture_ids?:string[];ward_codes?:string[]};
export type SearchInput={message:string;mode?:AssistantMode;identifier?:string;focus?:Focus;include_prediction?:boolean};
type Hub=Pick<HubStore,'pool'|'patientHistory'|'overview'|'antibiogram'|'sourceStatus'>;
type Entity={kind:'patient'|'culture'|'ward'|'isolate';id:string;row:Row};
const unique=(values:string[])=>[...new Set(values)];
const pick=(row:Row,keys:string[])=>Object.fromEntries(keys.filter(k=>row[k]!==undefined).map(k=>[k,row[k]]));
const splitTokens=(message:string)=>unique(message.match(/[A-Za-z0-9][A-Za-z0-9_-]{1,149}/g)||[]).slice(0,300);
const looksLikeId=(token:string)=>/^(\d{7}|MB\d{11,}(?:-\d+)?|P\d{6}|C\d{7}(?:-\d+)?|DEMO-[\w-]+)$/i.test(token);
function period(message:string) {
  const year=message.match(/\b(20\d{2})\b/);
  return year&&/annual|year|20\d{2}/i.test(message)?{from:`${year[1]}-01-01`,to:`${year[1]}-12-31`}:{};
}
function smallCulture(c:Row) {
  return {...pick(c,['culture_id','patient_id','sample_date','ward_code','ward_en','specimen','status','result','age_years','n_isolates']),
    isolates:c.isolates.slice(0,5).map((i:Row)=>({...pick(i,['isolate_id','organism','quantity','esbl','mrsa','vre','cpe']),ast:i.ast_results.map((a:Row)=>[a.antibiotic_code,a.result])})),
    ...(c.isolates.length>5?{omitted_isolates:c.isolates.length-5}:{})};
}

export class AssistantSearch {
  private predictions=new Map<string,{at:number;value:Row}>();
  constructor(private hub:Hub,private predictor=new Predictor()){}
  private async lookup(tokens:string[]):Promise<Entity[]> {
    if(!tokens.length)return [];
    const values=unique(tokens.map(t=>t.toLowerCase()));
    const definitions=[['patient','adt.patients','patient_id'],['culture','lis.cultures','culture_id'],['ward','adt.wards','ward_code'],['isolate','lis.isolates','isolate_id']] as const;
    const results=await Promise.all(definitions.map(async([kind,table,column])=>{
      const rows=(await this.hub.pool.query(`SELECT * FROM ${table} WHERE lower(${column})=ANY($1::text[]) ORDER BY ${column} LIMIT 5`,[values])).rows;
      return rows.map(row=>({kind,id:row[column],row}));
    }));
    return results.flat();
  }
  private async prediction(history:Row,cultureId:string,isolateId?:string):Promise<Row> {
    const sample=history.cultures.find((c:Row)=>c.culture_id===cultureId);
    const identity={patient_id:history.patient.patient_id,culture_id:cultureId,isolate_id:isolateId||sample?.isolates[0]?.isolate_id||null};
    if(!sample)return {...identity,status:'unavailable',reason:'No selected sample exists'};
    if(!['urine','blood','respiratory'].includes(sample.specimen))return {...identity,status:'unsupported',reason:`The supplied AMR model does not support ${sample.specimen} samples`};
    if(sample.age_years<18||sample.age_years>120)return {...identity,status:'unsupported',reason:'The supplied AMR model supports adults aged 18–120'};
    try {
      const meta=await this.predictor.metadata();
      const key=createHash('sha256').update(JSON.stringify({model:meta.model_id,identity,history})).digest('hex');
      const cached=this.predictions.get(key);if(cached&&Date.now()-cached.at<60000)return cached.value;
      const context=patientInputs(history,meta,cultureId),selected=isolateId?context.isolates.find((i:Row)=>i.isolate_id===isolateId):context.isolates[0];
      if(selected&&!selected.organism)return {...identity,status:'unsupported',reason:`Organism ${selected.source_organism} is unsupported by the AMR model`};
      const inputs={...context.inputs,...(selected?pick(selected,['organism','known_results','flags']):{})};
      const output=await this.predictor.call('predict',inputs);
      const compact=(r:Row)=>pick(r,['antibiotic','percent_works','percent_covers','p_resistant','aware','source']);
      const value={...identity,status:'available',model_id:meta.model_id,as_of_date:context.as_of_date,
        inputs:{...pick(inputs,['specimen','setting','age','organism','known_results','flags']),prior_result_count:inputs.history.prior_results.length,prior_organism_count:inputs.history.prior_organisms.length},
        empiric:{likely_organisms:output.empiric.likely_organisms.slice(0,3),percent_other_organism:output.empiric.percent_other_organism,top:output.empiric.top.map(compact),recommended:output.empiric.recommended.map(compact)},
        resistance:output.resistance?{organism:output.resistance.organism,top:output.resistance.top.map(compact),recommended:output.resistance.recommended.map(compact),ranked:output.resistance.ranked.slice(0,8).map(compact),observed:output.resistance.ranked.filter((r:Row)=>r.source==='lab').map(compact)}:null,
        limitations:[...context.notes,...(sample.result==='negative'?['This sample is negative; a model ranking does not establish an infection or an indication for an antibiotic.']:[])],unmapped:context.unmapped.slice(0,12),omitted_unmapped:Math.max(0,context.unmapped.length-12)};
      if(this.predictions.size>=100)this.predictions.delete(this.predictions.keys().next().value!);
      this.predictions.set(key,{at:Date.now(),value});return value;
    }catch(error){return {...identity,status:'unavailable',reason:(error as Error).message};}
  }
  async search(input:SearchInput,phase:(value:string)=>void=()=>{}):Promise<Row> {
    const started=performance.now(),message=String(input.message||'').trim();
    if(!message||message.length>4000)throw new AppError(400,'Enter a question of up to 4,000 characters');
    phase('searching');
    const tokens=splitTokens(message),messageEntities=await this.lookup(tokens),structured=tokens.filter(looksLikeId);
    for(const match of message.matchAll(/\b(patient(?:\s+id)?|culture(?:\s+id)?|ward(?:\s+code)?|isolate(?:\s+id)?)(?:\s*[:=#]\s*|\s+)([A-Za-z0-9][A-Za-z0-9_-]{1,149})\b/gi)){
      const value=match[2];if(/id|code/i.test(match[1])||/[0-9_-]/.test(value)||value===value.toUpperCase())if(!structured.includes(value))structured.push(value);
    }
    let entities=messageEntities,missing:Row[]=[];
    // A new ID in the question replaces the previous focus, including when it is missing.
    if(!entities.length&&!structured.length) {
      if(input.identifier?.trim()) {
        const selected=await this.lookup([input.identifier.trim()]);
        entities=selected.filter(e=>input.mode==='general'||!input.mode||e.kind===input.mode);
        if(!entities.length)missing.push({kind:input.mode||'record',id:input.identifier.trim()});
      } else {
        const focus=input.focus||{};
        entities=await this.lookup([...focus.patient_ids||[],...focus.culture_ids||[],...focus.ward_codes||[]].slice(0,6));
      }
    }
    for(const token of structured)if(!entities.some(e=>e.id.toLowerCase()===token.toLowerCase()))missing.push({kind:'record',id:token});
    const omittedEntities=Math.max(0,entities.length-4);entities=entities.slice(0,4);
    const records:Row={patients:[],cultures:[],wards:[]},sources:Row[]=[],notes:string[]=[],histories=new Map<string,Row>();
    const pending=/pending|await|waiting|unfinished|under test/i.test(message);
    const cultureIds=new Set<string>(),candidateCases=new Map<string,{patient_id:string;culture_id:string;isolate_id?:string}>();
    async function getHistory(hub:Hub,id:string) {if(!histories.has(id)){const value=await hub.patientHistory(id);if(value)histories.set(id,value);}return histories.get(id);}
    for(const entity of entities) {
      sources.push({kind:entity.kind,id:entity.id});
      if(entity.kind==='ward') {
        const ward=entity.row;
        const [summary,latest,organisms,antibiogram]=await Promise.all([
          this.hub.pool.query(`SELECT count(*)::integer AS cultures,count(DISTINCT patient_id)::integer AS patients_with_samples,count(*) FILTER(WHERE status<>'final')::integer AS pending,count(*) FILTER(WHERE result='positive')::integer AS positive,min(sample_date) AS first_sample,max(sample_date) AS latest_sample FROM lis.cultures WHERE ward_code=$1`,[entity.id]),
          this.hub.pool.query(`SELECT culture_id,patient_id,sample_date,specimen,result,status FROM lis.cultures WHERE ward_code=$1 ${pending?"AND status<>'final'":''} ORDER BY sample_date DESC,culture_id DESC LIMIT 6`,[entity.id]),
          this.hub.pool.query('SELECT i.organism,count(*)::integer AS isolates FROM lis.isolates i JOIN lis.cultures c USING(culture_id) WHERE c.ward_code=$1 GROUP BY i.organism ORDER BY isolates DESC LIMIT 5',[entity.id]),
          this.hub.antibiogram({ward:entity.id,...period(message)})
        ]);
        records.wards.push({record:pick(ward,['ward_code','ward_en','ward_type','institution']),summary:summary.rows[0],recent_samples:latest.rows,sample_list_scope:pending?'Latest 6 non-final samples':'Latest 6 samples',organisms:organisms.rows,antibiogram:{...antibiogram,rows:antibiogram.rows.slice(0,12),omitted_rows:Math.max(0,antibiogram.rows.length-12)}});
        notes.push('Ward patient counts mean distinct patients with recorded samples, not current occupancy. Individual AMR predictions require a patient or culture ID.');
        continue;
      }
      let patientId=entity.row.patient_id,cultureId=entity.kind==='culture'?entity.id:entity.kind==='isolate'?entity.row.culture_id:undefined;
      if(entity.kind==='patient')patientId=entity.id;
      if(entity.kind==='isolate'){const parent=(await this.hub.pool.query('SELECT patient_id FROM lis.cultures WHERE culture_id=$1',[cultureId])).rows[0];patientId=parent?.patient_id;}
      if(!patientId){notes.push(`The parent patient for ${entity.id} is unresolved`);continue;}
      const history=await getHistory(this.hub,patientId);if(!history){notes.push(`Patient ${patientId} is not yet available in the hub`);continue;}
      if(!records.patients.some((p:Row)=>p.record.patient_id===patientId))records.patients.push({record:pick(history.patient,['patient_id','sex','birth_year','home_area']),summary:history.summary,included_culture_ids:[],stays:history.stays.slice(0,3).map((s:Row)=>pick(s,['ward_code','ward_en','admission_date','origin']))});
      const selected=cultureId?history.cultures.filter((c:Row)=>c.culture_id===cultureId):(pending?history.cultures.filter((c:Row)=>c.status!=='final'):history.cultures).slice(0,4);
      for(const culture of selected)if(!cultureIds.has(culture.culture_id)){records.cultures.push(smallCulture(culture));cultureIds.add(culture.culture_id);}
      const patient=records.patients.find((p:Row)=>p.record.patient_id===patientId);patient.included_culture_ids=unique([...patient.included_culture_ids,...selected.map((c:Row)=>c.culture_id)]);patient.omitted_cultures=Math.max(0,history.cultures.length-patient.included_culture_ids.length);
      const target=cultureId||selected[0]?.culture_id||history.cultures[0]?.culture_id;
      if(target){
        const sample=history.cultures.find((c:Row)=>c.culture_id===target);
        const ids=entity.kind==='isolate'?[entity.id]:(sample?.isolates.length?sample.isolates.map((i:Row)=>i.isolate_id):[undefined]);
        for(const isolateId of ids)candidateCases.set(`${target}:${isolateId||''}`,{patient_id:patientId,culture_id:target,...(isolateId?{isolate_id:isolateId}:{})});
      }
    }
    if(!entities.length&&!missing.length) {
      const overview=await this.hub.overview();records.overview={totals:overview.totals,wards:overview.wards.slice(0,12).map((w:Row)=>pick(w,['ward_code','ward_en','cultures','pending'])),omitted_wards:Math.max(0,overview.wards.length-12),specimens:overview.specimens,organisms:overview.organisms};
      if(pending)records.pending_samples=(await this.hub.pool.query("SELECT culture_id,patient_id,ward_code,sample_date,specimen,status FROM lis.cultures WHERE status<>'final' ORDER BY sample_date DESC,culture_id DESC LIMIT 8")).rows;
      if(/antibiogram|resistan|susceptibil|annual|yearly/i.test(message)){const data=await this.hub.antibiogram(period(message));records.antibiogram={...data,rows:data.rows.slice(0,12),omitted_rows:Math.max(0,data.rows.length-12)};}
    }
    if(records.cultures.length) {
      const codes=unique(records.cultures.flatMap((c:Row)=>c.isolates.flatMap((i:Row)=>i.ast.map((a:string[])=>a[0])))) as string[];
      records.antibiotic_reference=(await this.hub.pool.query('SELECT antibiotic_code,antibiotic,reported_for FROM formulary.antibiotics WHERE antibiotic_code=ANY($1::text[])',[codes])).rows;
    }
    phase('predicting');
    const candidates=[...candidateCases.values()];
    const amr=input.include_prediction===false?[]:await Promise.all(candidates.slice(0,2).map(c=>this.prediction(histories.get(c.patient_id)!,c.culture_id,c.isolate_id)));
    if(candidates.length>2)notes.push('AMR predictions are limited to 2 selected sample/isolate cases per question; ask about a specific culture or isolate for the others.');
    if(records.patients.some((p:Row)=>!p.summary.samples))notes.push('A patient without a sample has no patient-specific AMR prediction.');
    const focus:Focus={patient_ids:entities.filter(e=>e.kind==='patient').map(e=>e.id),culture_ids:entities.filter(e=>e.kind==='culture'||e.kind==='isolate').map(e=>e.kind==='culture'?e.id:e.row.culture_id),ward_codes:entities.filter(e=>e.kind==='ward').map(e=>e.id)};
    const packet:Row={focus,entities:entities.map(e=>({kind:e.kind,id:e.id})),missing,sources,records,amr,
      definitions:{isolate:'An organism recovered from a culture sample.',S:'Susceptible laboratory result',R:'Resistant laboratory result',pending:'Unknown until reported; not a negative result.',ward:'Sample location or recorded ward-stay reference, not verified current patient location.'},
      notes:unique([...notes,'AMR estimates are research decision support, not prescriptions. Allergies, renal function, dose, route, medication administration and clinical release times are not supplied.']),
      retrieval:{queried_at:new Date().toISOString(),duration_ms:0,strategy:'Indexed exact IDs and fixed aggregate queries; no vector search',context_truncated:omittedEntities>0,omitted_entities:omittedEntities},
      synchronization:Object.values(this.hub.sourceStatus).map(s=>pick(s,['source','status','last_sync_at']))};
    // Keep valid structured JSON; never cut serialized data in the middle of a record.
    const oversized=()=>JSON.stringify(packet).length>18000;
    if(oversized()){
      packet.retrieval.context_truncated=true;
      records.cultures=records.cultures.slice(0,4);
      for(const c of records.cultures){c.omitted_isolates=(c.omitted_isolates||0)+Math.max(0,c.isolates.length-2);c.isolates=c.isolates.slice(0,2);}
      for(const ward of records.wards){const stats=ward.antibiogram;stats.omitted_rows+=Math.max(0,stats.rows.length-4);stats.rows=stats.rows.slice(0,4);}
      for(const prediction of amr)if(prediction.resistance){prediction.resistance.omitted_ranked=Math.max(0,prediction.resistance.ranked.length-3);prediction.resistance.ranked=prediction.resistance.ranked.slice(0,3);}
      packet.notes.push('Long context was shortened. Counts remain full-scope counts, but included lists are partial. Narrow the ID for complete results.');
      while(oversized()&&records.cultures.length>1)records.cultures.pop();
      while(oversized()&&records.wards.length>1)records.wards.pop();
      // Unusually large free-text source fields must not silently exhaust the model window.
      if(oversized()){packet.amr=[];packet.notes.push('AMR detail exceeded the context budget; use a specific culture or isolate ID.');}
      if(oversized()){records.cultures=[];records.wards=[];packet.notes.push('Detailed source rows exceeded the context budget. Only identifiers and patient summary counts are included.');}
      if(oversized()){records.antibiotic_reference=[];packet.notes.push('The antibiotic dictionary was omitted to fit the context budget.');}
      for(const patient of records.patients){patient.included_culture_ids=records.cultures.filter((c:Row)=>c.patient_id===patient.record.patient_id).map((c:Row)=>c.culture_id);patient.omitted_cultures=patient.summary.samples-patient.included_culture_ids.length;}
    }
    packet.retrieval.duration_ms=Math.round(performance.now()-started);return packet;
  }
}
