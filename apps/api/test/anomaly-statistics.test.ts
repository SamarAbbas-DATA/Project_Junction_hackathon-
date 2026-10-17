import test from 'node:test';
import assert from 'node:assert/strict';
import { fisherIncrease,adjustFalseDiscovery,proportionInterval } from '../src/anomaly-statistics.js';
import { detectWard,shiftDay } from '../src/anomaly-detector.js';
import { anomalyDemoPlan } from '../src/anomaly-demo.js';
import type { Row } from '../src/source-store.js';

const asOf='2026-10-17';
function cohort(kind:'resistance'|'cluster'):Row[]{
  const plan=anomalyDemoPlan(kind,'11111111-1111-4111-8111-111111111111',asOf,8100000);
  return plan.cases.map(c=>{
    const culture=plan.entries.find(e=>e.table==='cultures'&&e.row.culture_id===c.culture_id)!.row,isolate=plan.entries.find(e=>e.table==='isolates'&&e.row.isolate_id===c.isolate_id)!.row;
    return {...culture,...isolate,status:'final',culture_result:'positive',ast:{'TEST-AMP':{result:c.result,guideline:'ANOMALY-TEST-1'}}};
  });
}
test('exact increase tests, BH adjustment and confidence intervals handle small and degenerate tables',()=>{
  assert.ok(Math.abs(fisherIncrease(4,10,0,10)-0.0433436532508)<1e-10);assert.equal(fisherIncrease(0,10,0,10),1);assert.ok(fisherIncrease(1,40,20,40)>.99);assert.equal(fisherIncrease(0,0,0,10),1);
  assert.throws(()=>fisherIncrease(4,3,0,2));assert.deepEqual(adjustFalseDiscovery([{p_value:.01},{p_value:.04},{p_value:.02}]).map(x=>x.q_value),[.03,.04,.03]);
  assert.equal(proportionInterval(0,0),null);const interval=proportionInterval(1,10)!;assert.ok(interval[0]<.1&&interval[1]>.1&&interval[0]>=0&&interval[1]<=1);
});
test('matched final first isolates detect a large resistance increase with explicit denominators and adjusted evidence',()=>{
  const result=detectWard(cohort('resistance'),'ANOM-R',asOf);assert.equal(result.findings.length,1);const alert=result.findings[0];
  assert.equal(alert.type,'resistance');assert.equal(alert.evidence.current.total,40);assert.equal(alert.evidence.current.positive,30);assert.equal(alert.evidence.baseline.total,60);assert.equal(alert.evidence.baseline.positive,6);assert.ok(alert.evidence.q_value<.05);assert.equal(alert.evidence.increase_points,65);assert.equal(alert.records.length,40);
});
test('reported flag clusters count distinct patients and remain review signals',()=>{
  const rows=cohort('cluster'),result=detectWard([...rows,...rows.map(r=>({...r,isolate_id:r.isolate_id+'X'}))],'ANOM-C',asOf);
  assert.equal(result.findings.length,1);const alert=result.findings[0];assert.equal(alert.type,'cluster');assert.equal(alert.flag,'mrsa');assert.equal(alert.evidence.current.total,10);assert.equal(alert.evidence.current.positive,5);assert.equal(alert.evidence.baseline.total,60);
  assert.equal(detectWard(rows.map(r=>({...r,mrsa:0})),'ANOM-C',asOf).findings.length,0);
});
test('small cohorts, pending cultures, missing tests and incompatible guideline editions cannot produce resistance claims',()=>{
  const rows=cohort('resistance'),current=rows.filter(r=>r.sample_date>=shiftDay(asOf,-27)),baseline=rows.filter(r=>!current.includes(r));
  assert.equal(detectWard([...baseline,...current.slice(0,10)],'ANOM-R',asOf).findings.length,0);
  assert.equal(detectWard([...baseline,...current.map(r=>({...r,status:'preliminary'}))],'ANOM-R',asOf).findings.length,0);
  assert.equal(detectWard([...baseline,...current.map(r=>({...r,ast:{}}))],'ANOM-R',asOf).findings.length,0);
  assert.equal(detectWard([...baseline,...current.map(r=>({...r,ast:{'TEST-AMP':{result:'R',guideline:'OTHER-EDITION'}}}))],'ANOM-R',asOf).findings.length,0);
  const repeated=detectWard([...rows,...current.map(r=>({...r,culture_id:r.culture_id+'X',isolate_id:r.isolate_id+'X'}))],'ANOM-R',asOf);assert.equal(repeated.findings[0].evidence.current.total,40);
});
test('historical arrivals do not become current events and patients do not contribute to both comparison periods',()=>{
  const rows=cohort('resistance');assert.equal(detectWard(rows.map(r=>({...r,sample_date:shiftDay(r.sample_date,-365)})),'ANOM-R',asOf).findings.length,0);
  const first=rows.find(r=>r.sample_date>=shiftDay(asOf,-27))!,old=rows.find(r=>r.sample_date<shiftDay(asOf,-27))!;
  const independent=detectWard(rows.map(r=>r===old?{...r,patient_id:first.patient_id}:r),'ANOM-R',asOf);assert.equal(independent.findings[0].evidence.baseline.total,59);
  const corrected=detectWard(rows.map(r=>r.sample_date>=shiftDay(asOf,-27)?{...r,ast:{'TEST-AMP':{result:'S',guideline:'ANOMALY-TEST-1'}}}:r),'ANOM-R',asOf);assert.equal(corrected.findings.length,0);
});
