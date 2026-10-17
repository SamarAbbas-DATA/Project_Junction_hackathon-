import { randomInt,randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { HubStore } from './hub-store.js';
import { sourceHeaders } from './hub-store.js';
import { AppError,ports,hubPort,type SourceName } from './config.js';
import type { SourceStore,Row } from './source-store.js';
import { fhirChanges } from './fhir-source.js';
import { day,shiftDay } from './anomaly-detector.js';

type Kind='resistance'|'cluster'|'integration';
type Entry={source:SourceName;table:string;row:Row;shared?:boolean};
export function anomalyDemoPlan(kind:Exclude<Kind,'integration'>,id:string,asOf:string,base=randomInt(8000000,8999000)){
  const ward=kind==='resistance'?'ANOM-R':'ANOM-C',organism=kind==='resistance'?'Escherichia coli':'Staphylococcus aureus',specimen=kind==='resistance'?'urine':'blood';
  const entries:Entry[]=[
    {source:'adt',table:'wards',row:{ward_code:ward,ward_fi:kind==='resistance'?'Poikkeamatesti: resistenssi':'Poikkeamatesti: klusteri',ward_en:kind==='resistance'?'Anomaly test: resistance':'Anomaly test: cluster',ward_type:'out',institution:'hospital'}},
    {source:'formulary',table:'antibiotics',shared:true,row:{antibiotic_code:'TEST-AMP',antibiotic:'ampicillin (anomaly test reference)',antibiotic_fi:'ampisilliini (poikkeamatesti)',class:'penicillins',reported_for:'all'}},
    {source:'formulary',table:'guidelines',shared:true,row:{guideline:'ANOMALY-TEST-1',valid_from:null}},
    {source:'lis',table:'specimen_types',shared:true,row:{specimen,specimen_fi:specimen==='urine'?'virtsa':'veri'}}
  ];
  const cases:Row[]=[];const currentCount=kind==='resistance'?40:10;
  for(let index=0;index<60+currentCount;index++){
    const current=index>=60,position=current?index-60:index,patient=String(base+index),culture=`AT${id.replaceAll('-','').slice(0,12)}${index.toString().padStart(3,'0')}`,isolate=culture+'-1';
    const sample=shiftDay(asOf,current?-(position%7):-(28+position%60)),result=kind==='resistance'&&(current?position<30:position<6)?'R':'S',mrsa=kind==='cluster'&&current&&position<5?1:0;
    entries.push({source:'adt',table:'patients',row:{patient_id:patient,sex:index%2?'F':'M',birth_year:1960,home_area:'Anomaly test data'}});
    entries.push({source:'lis',table:'cultures',row:{culture_id:culture,patient_id:patient,ward_code:ward,admission_date:null,age_years:Number(sample.slice(0,4))-1960,sample_date:sample,specimen,result:null,n_isolates:0,status:'registered'}});
    entries.push({source:'lis',table:'isolates',row:{isolate_id:isolate,culture_id:culture,isolate_no:1,organism,quantity:null,esbl:0,mrsa,vre:0,cpe:0}});
    entries.push({source:'lis',table:'ast_results',row:{isolate_id:isolate,antibiotic_code:'TEST-AMP',result,guideline:'ANOMALY-TEST-1'}});
    cases.push({patient_id:patient,culture_id:culture,isolate_id:isolate,current,result,mrsa});
  }
  return {ward,as_of:asOf,entries,cases};
}

export class AnomalyDemoService{
  private busy=false;
  constructor(private hub:HubStore,private stores:Record<string,SourceStore>,private intake=(source:string,bundle:Row)=>this.postIntake(source,bundle)){}
  private enabled(){if(process.env.ANOMALY_DEMO_ENABLED==='false'||process.env.NODE_ENV==='production')throw new AppError(404,'Anomaly demo is disabled');}
  private async source(source:SourceName,table:string,key?:string,method='GET',body?:Row,headers:Record<string,string>={}){
    const response=await fetch(`http://127.0.0.1:${ports[source]}/${table}${key?'/'+encodeURIComponent(key):''}`,{method,headers:{...sourceHeaders(),...(body?{'content-type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
    const data=await response.json() as Row;if(!response.ok)throw new AppError(response.status,`Test source ${table}: ${data.error}`);return data;
  }
  private async postIntake(source:string,bundle:Row){const response=await fetch(`http://127.0.0.1:${hubPort}/api/intake/fhir/${source}`,{method:'POST',headers:{...sourceHeaders(),'content-type':'application/fhir+json'},body:JSON.stringify(bundle),signal:AbortSignal.timeout(15000)});return {status:response.status,body:await response.json()};}
  async load(kind:Kind):Promise<Row>{
    this.enabled();if(this.busy)throw new AppError(409,'Another test scenario is running');this.busy=true;
    try{
      let run=(await this.hub.pool.query('SELECT * FROM anomaly_demo_runs WHERE kind=$1',[kind])).rows[0];
      if(run?.state==='corrected')return await this.change(run,true);
      if(run?.state==='ready')return {id:run.id,kind,state:run.state,ward_code:run.plan.ward,reused:true};
      if(!run){
        const id=randomUUID(),plan=kind==='integration'?{}:anomalyDemoPlan(kind,id,day(new Date()));
        run=(await this.hub.pool.query("INSERT INTO anomaly_demo_runs(id,kind,state,plan) VALUES($1,$2,'preparing',$3) RETURNING *",[id,kind,plan])).rows[0];
      }
      if(kind==='integration'){
        // Deliberately malformed test message. It is saved to the inbox and
        // rejected; no source patient or clinical result is inserted.
        const message={resourceType:'Bundle',type:'message',identifier:{value:'anomaly-rejection-'+run.id},timestamp:new Date().toISOString(),entry:[]};
        const result=await this.intake('lis',message);if(result.status!==422)throw new Error('Test message did not produce the expected rejection');
        await this.hub.pool.query("UPDATE anomaly_demo_runs SET state='ready',last_message=$2,error=NULL WHERE id=$1",[run.id,message]);
        return {id:run.id,kind,state:'ready',rejected:true};
      }
      const versions:Row={...run.expected_versions};let created=0;
      for(const [index,entry]of (run.plan.entries as Entry[]).entries()){
        if(entry.shared){
          const businessKey=entry.row.specimen||entry.row.antibiotic_code||entry.row.guideline;
          const existing=this.stores[entry.source].get(entry.table,businessKey);
          if(existing){if(entry.table!=='specimen_types'&&Object.entries(entry.row).some(([key,value])=>existing[key]!==value))throw new AppError(409,'A test reference ID is already used by different data');continue;}
        }
        const saved=await this.source(entry.source,entry.table,undefined,'POST',entry.row,{'idempotency-key':`anomaly-${run.id}-${index}`});created++;
        if(entry.table==='ast_results')versions['ast:'+saved.isolate_id]=saved.record_version;
        if(entry.table==='isolates')versions['isolate:'+saved.isolate_id]=saved.record_version;
      }
      for(const c of run.plan.cases){const current=await this.source('lis','cultures',c.culture_id);if(current.status!=='final')await this.source('lis','cultures',c.culture_id,'PATCH',{status:'final'},{'if-match':String(current.record_version)});}
      const last=run.plan.cases.at(-1),event=this.stores.lis.db.prepare("SELECT event_id FROM events WHERE entity='ast_results' AND record_key=? ORDER BY event_id DESC LIMIT 1").get(last.isolate_id+'~TEST-AMP') as Row;
      const message=fhirChanges(this.stores.lis,Number(event.event_id)-1,1).messages[0];
      await this.hub.pool.query("UPDATE anomaly_demo_runs SET state='ready',expected_versions=$2,last_message=$3,error=NULL WHERE id=$1",[run.id,versions,message]);
      await this.hub.sync();return {id:run.id,kind,state:'ready',ward_code:run.plan.ward,patient_id:run.plan.cases.find((c:Row)=>c.current).patient_id,culture_id:run.plan.cases.find((c:Row)=>c.current).culture_id,patients:run.plan.cases.length,created};
    }catch(error){await this.hub.pool.query("UPDATE anomaly_demo_runs SET error=$2 WHERE kind=$1",[kind,(error as Error).message]);throw error;}finally{this.busy=false;}
  }
  private async change(run:Row,restore=false){
    if(!['resistance','cluster'].includes(run.kind)||!['ready','corrected'].includes(run.state))throw new AppError(409,'Load a completed biological test first');
    const versions={...run.expected_versions},targets=run.plan.cases.filter((c:Row)=>c.current&&(run.kind==='resistance'?c.result==='R':c.mrsa===1));
    const table=run.kind==='resistance'?'ast_results':'isolates',prefix=run.kind==='resistance'?'ast:':'isolate:';
    // Validate every owned version before editing. External corrections are
    // protected rather than silently overwritten by a demonstration.
    for(const c of targets){const record=await this.source('lis',table,c.isolate_id+(table==='ast_results'?'~TEST-AMP':''));if(record.record_version!==versions[prefix+c.isolate_id])throw new AppError(409,'A test record was changed elsewhere; review it before running this correction');}
    for(const c of targets){
      const patch=run.kind==='resistance'?{result:restore?'R':'S'}:{mrsa:restore?1:0};
      const saved=await this.source('lis',table,c.isolate_id+(table==='ast_results'?'~TEST-AMP':''),'PATCH',patch,{'if-match':String(versions[prefix+c.isolate_id])});versions[prefix+c.isolate_id]=saved.record_version;
      await this.hub.pool.query('UPDATE anomaly_demo_runs SET expected_versions=$2 WHERE id=$1',[run.id,versions]);
    }
    const state=restore?'ready':'corrected';await this.hub.pool.query('UPDATE anomaly_demo_runs SET state=$2,error=NULL WHERE id=$1',[run.id,state]);await this.hub.sync();return {id:run.id,kind:run.kind,state,ward_code:run.plan.ward,changed:targets.length};
  }
  async correct(kind:Kind){this.enabled();if(this.busy)throw new AppError(409,'Another test scenario is running');this.busy=true;try{const run=(await this.hub.pool.query('SELECT * FROM anomaly_demo_runs WHERE kind=$1',[kind])).rows[0];if(!run)throw new AppError(404,'Load the test scenario first');if(run.state==='corrected')return {state:'corrected',changed:0};return await this.change(run);}finally{this.busy=false;}}
  async replay(kind:Kind){this.enabled();const run=(await this.hub.pool.query('SELECT * FROM anomaly_demo_runs WHERE kind=$1',[kind])).rows[0];if(!run?.last_message)throw new AppError(404,'Load the test scenario first');return this.intake('lis',run.last_message);}
  async status(){return {runs:(await this.hub.pool.query('SELECT id,kind,state,plan->>\'ward\' AS ward_code,error,created_at FROM anomaly_demo_runs ORDER BY kind')).rows};}
}

export function registerAnomalyDemo(app:FastifyInstance,service:AnomalyDemoService){
  const params={type:'object',required:['kind'],properties:{kind:{enum:['resistance','cluster','integration']}}};
  app.get('/api/anomalies/demo/status',async()=>service.status());
  app.post('/api/anomalies/demo/:kind',{schema:{params}},async request=>service.load((request.params as Row).kind));
  app.post('/api/anomalies/demo/:kind/correct',{schema:{params}},async request=>service.correct((request.params as Row).kind));
  app.post('/api/anomalies/demo/:kind/replay',{schema:{params}},async request=>service.replay((request.params as Row).kind));
}
