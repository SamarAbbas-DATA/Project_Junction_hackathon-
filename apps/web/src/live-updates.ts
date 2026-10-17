import type { Row } from './api';

// SSE carries the affected clinical scope, never source tables or FHIR. Keep
// unrelated patient histories and filtered antibiograms in their cache.
export function affectedQuery(key:readonly unknown[],event:Row){
  const kind=String(key[0]);
  if(event.type==='anomalies.updated')return ['anomalies','anomaly-summary','anomaly-detail','anomaly-demo'].includes(kind);
  if(['anomalies','anomaly-summary','anomaly-detail','anomaly-demo'].includes(kind))return event.type==='connected';
  if(['models','catalog','assistant-status','predictor-meta'].includes(kind))return false;
  if(event.type==='connected'||!event.affected)return true;
  const a=event.affected,tables:string[]=a.tables||[],source=event.source;
  if(['records','source-count','detail'].includes(kind))return key[1]===source&&tables.includes(String(key[2]));
  if(kind==='patient-history')return (a.patient_ids||[]).includes(key[1]);
  if(['patients','predictor-patient-search'].includes(kind))return source==='adt'||tables.some(t=>['cultures','isolates','ast_results'].includes(t));
  if(kind==='antibiogram'){
    if(!tables.some(t=>['cultures','isolates','ast_results','antibiotics'].includes(t)))return false;
    if(source==='formulary')return true;
    const filters=new URLSearchParams(String(key[1]||'')),ward=filters.get('ward'),organism=filters.get('organism');
    if(ward&&a.ward_codes?.length&&!a.ward_codes.includes(ward))return false;
    if(organism&&a.organisms?.length&&!a.organisms.includes(organism))return false;
    return true;
  }
  return true;
}
