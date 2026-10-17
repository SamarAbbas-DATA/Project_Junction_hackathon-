import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import type { HubStore } from './hub-store.js';
import type { Row } from './source-store.js';
import { adjustFalseDiscovery,fisherIncrease,proportionInterval } from './anomaly-statistics.js';
import { enqueueAnomalyWork,saveFindings,type AnomalyFinding } from './anomaly-store.js';

export const anomalyRules=JSON.parse(readFileSync(new URL('../resources/anomalies/rules.json',import.meta.url),'utf8')) as {
  version:string;description:string;current_days:number;baseline_days:number;minimum_tested:number;minimum_increase:number;false_discovery_rate:number;
  cluster_days:number;cluster_minimum_patients:number;cluster_minimum_baseline:number;cluster_minimum_increase:number;quality_grace_seconds:number;rejection_window_hours:number;worker_interval_ms:number;
};
for(const key of ['current_days','baseline_days','minimum_tested','cluster_days','cluster_minimum_patients','cluster_minimum_baseline','quality_grace_seconds','rejection_window_hours','worker_interval_ms'] as const)
  if(!Number.isSafeInteger(anomalyRules[key])||anomalyRules[key]<1)throw new Error(`Invalid anomaly setting: ${key}`);
for(const key of ['minimum_increase','false_discovery_rate','cluster_minimum_increase'] as const)if(!(anomalyRules[key]>0&&anomalyRules[key]<1))throw new Error(`Invalid anomaly setting: ${key}`);
export const day=(date:Date)=>date.toISOString().slice(0,10);
export function shiftDay(date:string,offset:number){const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+offset);return day(d);}
const key=(...values:unknown[])=>JSON.stringify(values);
const round=(n:number)=>Math.round(n*1000000)/1000000;
type Comparison={finding:AnomalyFinding;p_value:number;increase:number;current_positive:number};
type Group={organism:string;specimen:string;antibiotic_code?:string;guideline?:string;flag?:string;current:Row[];baseline:Row[]};

function periods(rows:Row[],asOf:string,currentDays:number,rules=anomalyRules){
  const currentFrom=shiftDay(asOf,1-currentDays),baselineTo=shiftDay(currentFrom,-1),baselineFrom=shiftDay(currentFrom,-rules.baseline_days);
  const current=rows.filter(r=>r.sample_date>=currentFrom&&r.sample_date<=asOf),currentPatients=new Set(current.map(r=>key(r.patient_id,r.organism,r.specimen)));
  // A patient in the current period does not also contribute to its baseline.
  const baseline=rows.filter(r=>r.sample_date>=baselineFrom&&r.sample_date<=baselineTo&&!currentPatients.has(key(r.patient_id,r.organism,r.specimen)));
  return {current,baseline,currentFrom,baselineTo,baselineFrom};
}
function firstIsolates(rows:Row[]){const result=new Map<string,Row>();for(const row of rows){const id=key(row.patient_id,row.organism,row.specimen);if(!result.has(id))result.set(id,row);}return [...result.values()];}
function comparison(group:Group,ward:string,dates:ReturnType<typeof periods>,type:'resistance'|'cluster',rules=anomalyRules):Comparison{
  const count=(rows:Row[])=>rows.filter(r=>type==='resistance'?r.result==='R':r[group.flag!]===1).length;
  const currentPositive=count(group.current),baselinePositive=count(group.baseline),currentTotal=group.current.length,baselineTotal=group.baseline.length;
  const p=fisherIncrease(currentPositive,currentTotal,baselinePositive,baselineTotal),increase=currentPositive/currentTotal-baselinePositive/baselineTotal;
  const records=group.current.map(row=>({...row,ast:undefined,period:'current'}));
  const finding:AnomalyFinding={fingerprint:key(type,ward,group.organism,group.specimen,group.antibiotic_code||group.flag,group.guideline||''),type,
    code:type==='resistance'?'resistance_increase':'resistant_cluster',source:'lis',ward_code:ward,organism:group.organism,specimen:group.specimen,antibiotic_code:group.antibiotic_code,flag:group.flag,
    records,evidence:{as_of:dates.currentFrom?shiftDay(dates.currentFrom,(type==='resistance'?rules.current_days:rules.cluster_days)-1):'',
      current:{from:dates.currentFrom,to:shiftDay(dates.currentFrom,(type==='resistance'?rules.current_days:rules.cluster_days)-1),positive:currentPositive,total:currentTotal,rate:round(currentPositive/currentTotal),interval_95:proportionInterval(currentPositive,currentTotal)},
      baseline:{from:dates.baselineFrom,to:dates.baselineTo,positive:baselinePositive,total:baselineTotal,rate:round(baselinePositive/baselineTotal),interval_95:proportionInterval(baselinePositive,baselineTotal)},
      expected_current:round(currentTotal*baselinePositive/baselineTotal),increase_points:round(increase*100),p_value:p,guideline:group.guideline||null,rule_settings:{...rules},
      method:'One-sided Fisher exact test; Benjamini-Hochberg adjustment across all eligible resistance/flag comparisons in this ward.',
      selection:type==='resistance'?'First final positive-culture isolate per patient/organism/specimen within each period, selected before AST; current-period patients excluded from baseline. Reported S/R only; same guideline edition.':'Distinct patients with final positive-culture isolates of the same organism/specimen; any reported flag in the period counts once. Current-period patients excluded from baseline.',
      limitations:'Research/demo surveillance settings. Sample-location cohort, not current ward occupancy or confirmed transmission. Sampling practice can affect this signal.'}};
  return {finding,p_value:p,increase,current_positive:currentPositive};
}

export function detectWard(rows:Row[],ward:string,asOf:string,rules=anomalyRules){
  const sorted=[...rows].filter(r=>r.status==='final'&&r.culture_result==='positive').sort((a,b)=>a.sample_date.localeCompare(b.sample_date)||a.culture_id.localeCompare(b.culture_id)||a.isolate_id.localeCompare(b.isolate_id));
  const dates=periods(sorted,asOf,rules.current_days,rules),rateGroups=new Map<string,Group>();
  for(const period of ['current','baseline'] as const)for(const row of firstIsolates(dates[period]))for(const [code,ast] of Object.entries(row.ast||{}) as [string,Row][]){
    if(!['S','R'].includes(ast.result)||!ast.guideline)continue;
    const id=key(row.organism,row.specimen,code,ast.guideline);if(!rateGroups.has(id))rateGroups.set(id,{organism:row.organism,specimen:row.specimen,antibiotic_code:code,guideline:ast.guideline,current:[],baseline:[]});
    rateGroups.get(id)![period].push({...row,result:ast.result,guideline:ast.guideline,antibiotic_code:code});
  }
  const clusterDates=periods(sorted,asOf,rules.cluster_days,rules),clusters=new Map<string,Group>();
  for(const flag of ['mrsa','esbl','vre','cpe'])for(const period of ['current','baseline'] as const){
    const patients=new Map<string,Row>();for(const row of clusterDates[period]){const id=key(row.patient_id,row.organism,row.specimen);if(!patients.has(id)||row[flag]===1)patients.set(id,row);}
    for(const row of patients.values()){
      const id=key(row.organism,row.specimen,flag);if(!clusters.has(id))clusters.set(id,{organism:row.organism,specimen:row.specimen,flag,current:[],baseline:[]});clusters.get(id)![period].push(row);
    }
  }
  const comparisons:Comparison[]=[];let suppressed=0;
  for(const group of rateGroups.values()){
    if(group.current.length<rules.minimum_tested||group.baseline.length<rules.minimum_tested){suppressed++;continue;}
    comparisons.push(comparison(group,ward,dates,'resistance',rules));
  }
  for(const group of clusters.values()){
    if(group.current.length<rules.cluster_minimum_patients||group.baseline.length<rules.cluster_minimum_baseline){suppressed++;continue;}
    comparisons.push(comparison(group,ward,clusterDates,'cluster',rules));
  }
  const findings=adjustFalseDiscovery(comparisons).filter(item=>item.q_value<=rules.false_discovery_rate&&item.increase>=(item.finding.type==='resistance'?rules.minimum_increase:rules.cluster_minimum_increase)&&(item.finding.type!=='cluster'||item.current_positive>=rules.cluster_minimum_patients)).map(item=>{
    item.finding.evidence.q_value=item.q_value;item.finding.evidence.comparisons_in_family=comparisons.length;return item.finding;
  });
  return {findings,statistics:{eligible_comparisons:comparisons.length,suppressed_small_or_incompatible_groups:suppressed,isolates_considered:sorted.length,alerts:findings.length}};
}

export class AnomalyDetector{
  private running=false;private stopped=false;private timer?:ReturnType<typeof setInterval>;private pending?:Promise<unknown>;private lastDay='';private lastQuality=0;
  constructor(private hub:Pick<HubStore,'pool'|'onChange'|'sourceStatus'>,private now=()=>new Date()){}
  async start(){
    await enqueueAnomalyWork(this.hub.pool,{},'lis');this.lastDay=day(this.now());
    this.timer=setInterval(()=>{if(!this.running&&!this.stopped)this.pending=this.tick().catch(error=>console.error('Anomaly worker:',error.message));},anomalyRules.worker_interval_ms);
    this.pending=this.tick();await this.pending;
  }
  async stop(){this.stopped=true;if(this.timer)clearInterval(this.timer);await this.pending;}
  async tick(){
    if(this.running||this.stopped)return;this.running=true;
    try{
      const now=this.now(),asOf=day(now);
      if(this.lastDay!==asOf){await enqueueAnomalyWork(this.hub.pool,{},'lis');this.lastDay=asOf;}
      if(now.valueOf()-this.lastQuality>=30000){await enqueueAnomalyWork(this.hub.pool,{});this.lastQuality=now.valueOf();}
      for(let i=0;i<10&&!this.stopped;i++)if(!await this.process(asOf,now))break;
    }finally{this.running=false;}
  }
  private async process(asOf:string,now:Date){
    const client=await this.hub.pool.connect();let job:Row|undefined,changed=0;
    try{
      await client.query('BEGIN');
      const lock=(await client.query("SELECT pg_try_advisory_xact_lock(hashtext('amr-anomaly-worker')) AS locked")).rows[0].locked;
      if(!lock){await client.query('ROLLBACK');return false;}
      job=(await client.query("SELECT * FROM anomaly_jobs WHERE generation>processed_generation AND run_after<=now() ORDER BY (scope_key='quality') DESC,updated_at,scope_key LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];
      if(!job){await client.query('COMMIT');return false;}
      const offline=Object.values(this.hub.sourceStatus).some(s=>s.status!=='connected');
      if(job.scope_key!=='quality'&&offline)throw new Error('Source synchronization unavailable; biological comparisons paused');
      if(job.scope_key==='quality'){
        const findings=await this.quality(client,now);changed=await saveFindings(client,findings,{quality:true},anomalyRules.version);
        await this.evaluation(client,job.scope_key,asOf,{alerts:findings.length});
      }else{
        const wards=job.ward_code?[job.ward_code]:(await client.query("SELECT ward_code FROM adt.wards UNION SELECT ward_code FROM lis.cultures UNION SELECT ward_code FROM anomaly_alerts WHERE ward_code IS NOT NULL ORDER BY ward_code")).rows.map(r=>r.ward_code);
        for(const ward of wards){
          const rows=(await client.query(`SELECT i.*,c.patient_id,c.ward_code,c.sample_date,c.specimen,c.status,c.result AS culture_result,
            coalesce(jsonb_object_agg(a.antibiotic_code,jsonb_build_object('result',a.result,'guideline',a.guideline)) FILTER(WHERE a.antibiotic_code IS NOT NULL),'{}'::jsonb) AS ast
            FROM lis.isolates i JOIN lis.cultures c USING(culture_id) LEFT JOIN lis.ast_results a USING(isolate_id)
            WHERE c.ward_code=$1 AND c.sample_date BETWEEN $2 AND $3 AND c.status='final' GROUP BY i.isolate_id,c.culture_id`,[ward,shiftDay(asOf,1-anomalyRules.current_days-anomalyRules.baseline_days),asOf])).rows;
          const result=detectWard(rows,ward,asOf);changed+=await saveFindings(client,result.findings,{ward},anomalyRules.version);await this.evaluation(client,'ward:'+ward,asOf,result.statistics);
        }
      }
      await client.query('UPDATE anomaly_jobs SET processed_generation=$2,attempts=0,error=NULL,updated_at=now() WHERE scope_key=$1',[job.scope_key,job.generation]);
      await client.query('COMMIT');
      if(changed)this.hub.onChange({type:'anomalies.updated',count:changed,affected:{ward_codes:job.ward_code?[job.ward_code]:[]}});
      return true;
    }catch(error){
      await client.query('ROLLBACK');if(!job)throw error;
      await client.query("UPDATE anomaly_jobs SET attempts=attempts+1,error=$2,run_after=now()+interval '10 seconds' WHERE scope_key=$1",[job.scope_key,(error as Error).message]);return false;
    }finally{client.release();}
  }
  private async evaluation(client:PoolClient,scope:string,asOf:string,statistics:Row){await client.query('INSERT INTO anomaly_evaluations(scope_key,as_of,rule_version,statistics) VALUES($1,$2,$3,$4)',[scope,asOf,anomalyRules.version,statistics]);}
  private async quality(client:PoolClient,now:Date){
    const findings:AnomalyFinding[]=[];
    const rejected=(await client.query(`SELECT source,message_id,error,received_at FROM integration_inbox WHERE status='rejected' AND received_at >= $1 ORDER BY source,message_id`,[new Date(now.valueOf()-anomalyRules.rejection_window_hours*3600000)])).rows;
    for(const source of [...new Set(rejected.map(r=>r.source))]){
      const records=rejected.filter(r=>r.source===source).map(r=>({...r,received_at:r.received_at.toISOString()}));findings.push({fingerprint:key('quality','rejected',source),type:'data_quality',code:'rejected_messages',source,records,evidence:{count:records.length,window_hours:anomalyRules.rejection_window_hours,reason:'FHIR messages were rejected; clean tables were not partially updated.',examples:records.slice(0,5)}});
    }
    const grace=new Date(now.valueOf()-anomalyRules.quality_grace_seconds*1000);
    const broken=(await client.query(`SELECT c.culture_id,c.patient_id,c.ward_code,c.specimen,c.sample_date,c.status,c.n_isolates,count(i.isolate_id)::integer AS actual_isolates,
      (p.patient_id IS NULL) AS missing_patient,(w.ward_code IS NULL) AS missing_ward
      FROM lis.cultures c LEFT JOIN adt.patients p USING(patient_id) LEFT JOIN adt.wards w USING(ward_code) LEFT JOIN lis.isolates i USING(culture_id)
      LEFT JOIN anomaly_subject_seen s USING(culture_id)
      WHERE coalesce(s.last_changed_at,c.updated_at::timestamptz)<$1
      GROUP BY c.culture_id,p.patient_id,w.ward_code HAVING p.patient_id IS NULL OR w.ward_code IS NULL OR (c.status='final' AND c.n_isolates<>count(i.isolate_id)) ORDER BY c.culture_id`,[grace])).rows;
    for(const [code,predicate]of [['unresolved_references',(r:Row)=>r.missing_patient||r.missing_ward],['final_count_mismatch',(r:Row)=>r.status==='final'&&r.n_isolates!==r.actual_isolates]] as const){
      const records=broken.filter(predicate);if(records.length)findings.push({fingerprint:key('quality',code,'lis'),type:'data_quality',code,source:'lis',records,evidence:{count:records.length,grace_seconds:anomalyRules.quality_grace_seconds,reason:code==='unresolved_references'?'Sample references remain unresolved after the cross-source arrival grace period.':'Final culture isolate count disagrees with the linked isolate records after the arrival grace period.'}});
    }
    const orphans=(await client.query(`SELECT i.isolate_id,i.culture_id,'isolate' AS record_kind,i.isolate_id AS record_key FROM lis.isolates i LEFT JOIN lis.cultures c USING(culture_id) LEFT JOIN anomaly_subject_seen s ON s.culture_id=i.culture_id WHERE c.culture_id IS NULL AND coalesce(s.last_changed_at,i.updated_at::timestamptz)<$1
      UNION ALL SELECT a.isolate_id,NULL,'ast',a.isolate_id||'~'||a.antibiotic_code FROM lis.ast_results a LEFT JOIN lis.isolates i USING(isolate_id) LEFT JOIN anomaly_isolate_seen s ON s.isolate_id=a.isolate_id WHERE i.isolate_id IS NULL AND coalesce(s.last_changed_at,a.updated_at::timestamptz)<$1 ORDER BY record_kind,record_key`,[grace])).rows;
    if(orphans.length)findings.push({fingerprint:key('quality','orphaned_results','lis'),type:'data_quality',code:'orphaned_results',source:'lis',records:orphans,evidence:{count:orphans.length,grace_seconds:anomalyRules.quality_grace_seconds,reason:'Isolate/culture or AST/isolate links remain unresolved after the arrival grace period.'}});
    for(const state of Object.values(this.hub.sourceStatus))if(state.status==='offline'&&state.last_sync_at&&new Date(state.last_sync_at)<grace)findings.push({fingerprint:key('quality','offline',state.source),type:'data_quality',code:'source_offline',source:state.source,records:[],evidence:{reason:'Source synchronization is unavailable; biological comparisons are paused.',last_sync_at:state.last_sync_at,error:state.error}});
    for(const finding of findings)finding.evidence.rule_settings={...anomalyRules};return findings;
  }
}
