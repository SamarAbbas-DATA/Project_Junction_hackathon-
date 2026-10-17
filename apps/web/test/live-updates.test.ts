import { describe,it,expect } from 'vitest';
import { affectedQuery } from '../src/live-updates';

describe('scoped live updates',()=>{
  it('refreshes anomaly evidence on detector updates without refetching unrelated clinical tables',()=>{
    const event={type:'anomalies.updated',affected:{ward_codes:['MED-02']}};
    expect(affectedQuery(['anomalies','status=active'],event)).toBe(true);expect(affectedQuery(['anomaly-detail','id'],event)).toBe(true);expect(affectedQuery(['anomaly-summary'],event)).toBe(true);
    expect(affectedQuery(['patient-history','1018112'],event)).toBe(false);expect(affectedQuery(['records','lis','cultures'],event)).toBe(false);
    expect(affectedQuery(['anomaly-summary'],lab)).toBe(false);expect(affectedQuery(['anomaly-summary'],{type:'connected'})).toBe(true);
  });
  const lab={type:'source.updated',source:'lis',affected:{tables:['cultures','ast_results'],patient_ids:['1018112'],culture_ids:['C1'],ward_codes:['MED-02'],organisms:['Escherichia coli']}};
  it('refreshes affected clinical data and leaves unrelated histories and source lists cached',()=>{
    expect(affectedQuery(['patient-history','1018112'],lab)).toBe(true);
    expect(affectedQuery(['patient-history','OTHER'],lab)).toBe(false);
    expect(affectedQuery(['records','adt','patients',''],lab)).toBe(false);
    expect(affectedQuery(['records','lis','cultures',''],lab)).toBe(true);
    expect(affectedQuery(['antibiogram','ward=MED-02'],lab)).toBe(true);
    expect(affectedQuery(['antibiogram','ward=ICU'],lab)).toBe(false);
    expect(affectedQuery(['antibiogram','organism=Other'],lab)).toBe(false);
    expect(affectedQuery(['overview'],lab)).toBe(true);
    expect(affectedQuery(['assistant-status'],lab)).toBe(false);
  });
  it('refreshes on reconnect and applies reference corrections to every antibiogram',()=>{
    expect(affectedQuery(['patient-history','OTHER'],{type:'connected'})).toBe(true);
    expect(affectedQuery(['antibiogram','ward=ICU'],{type:'source.updated',source:'formulary',affected:{tables:['antibiotics']}})).toBe(true);
    expect(affectedQuery(['catalog'],{type:'connected'})).toBe(false);
  });
});
