import type { Pool,PoolClient } from 'pg';
import { randomUUID,createHash } from 'node:crypto';
import { AppError } from './config.js';
import type { Row } from './source-store.js';

export type AnomalyFinding={fingerprint:string;type:'resistance'|'cluster'|'data_quality';code:string;source:string;ward_code?:string;organism?:string;specimen?:string;antibiotic_code?:string;flag?:string;evidence:Row;records:Row[]};
export async function initializeAnomalies(pool:Pool){
  await pool.query(`CREATE TABLE IF NOT EXISTS anomaly_jobs(
    scope_key TEXT PRIMARY KEY,ward_code TEXT,generation BIGINT NOT NULL DEFAULT 1,processed_generation BIGINT NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,run_after TIMESTAMPTZ NOT NULL DEFAULT now(),error TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS anomaly_subject_seen(culture_id TEXT PRIMARY KEY,last_changed_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS anomaly_isolate_seen(isolate_id TEXT PRIMARY KEY,last_changed_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS anomaly_alerts(
    id UUID PRIMARY KEY,fingerprint TEXT UNIQUE NOT NULL,type TEXT NOT NULL,code TEXT NOT NULL,source TEXT NOT NULL,ward_code TEXT,organism TEXT,specimen TEXT,antibiotic_code TEXT,flag TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','dismissed','resolved')),active BOOLEAN NOT NULL DEFAULT true,
    episode INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,rule_version TEXT NOT NULL,evidence JSONB NOT NULL,evidence_hash TEXT NOT NULL,
    first_detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),last_detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),last_evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),resolved_at TIMESTAMPTZ);
    CREATE INDEX IF NOT EXISTS idx_anomaly_active ON anomaly_alerts(active,status,ward_code);
    CREATE TABLE IF NOT EXISTS anomaly_links(
    alert_id UUID NOT NULL REFERENCES anomaly_alerts(id) ON DELETE CASCADE,kind TEXT NOT NULL,record_key TEXT NOT NULL,patient_id TEXT,culture_id TEXT,record JSONB NOT NULL,
    PRIMARY KEY(alert_id,kind,record_key));
    CREATE INDEX IF NOT EXISTS idx_anomaly_patient ON anomaly_links(patient_id,alert_id);
    CREATE INDEX IF NOT EXISTS idx_anomaly_culture ON anomaly_links(culture_id,alert_id);
    CREATE TABLE IF NOT EXISTS anomaly_review_history(
    id BIGSERIAL PRIMARY KEY,alert_id UUID NOT NULL REFERENCES anomaly_alerts(id),episode INTEGER NOT NULL,action TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',actor TEXT NOT NULL,at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS anomaly_evaluations(
    id BIGSERIAL PRIMARY KEY,scope_key TEXT NOT NULL,as_of DATE NOT NULL,rule_version TEXT NOT NULL,statistics JSONB NOT NULL,completed_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS anomaly_demo_runs(id UUID PRIMARY KEY,kind TEXT UNIQUE NOT NULL,state TEXT NOT NULL,plan JSONB NOT NULL,expected_versions JSONB NOT NULL DEFAULT '{}',last_message JSONB,error TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
}

// Called using the intake transaction's connection: a committed change can
// never lose its detection job, including when the process stops immediately.
export async function enqueueAnomalyWork(client:Pick<PoolClient,'query'>,scope:{ward_codes?:string[];culture_ids?:string[];isolate_ids?:string[];tables?:string[]},source?:string){
  const wards=[...new Set((scope.ward_codes||[]).filter(Boolean))].sort();
  const keys=source==='formulary'||(!wards.length&&source==='lis')?['all']:wards.map(w=>'ward:'+w);
  keys.push('quality');
  for(const key of keys.sort())await client.query(`INSERT INTO anomaly_jobs(scope_key,ward_code) VALUES($1,$2)
    ON CONFLICT(scope_key) DO UPDATE SET generation=anomaly_jobs.generation+1,run_after=LEAST(anomaly_jobs.run_after,now()),updated_at=now()`,[key,key.startsWith('ward:')?key.slice(5):null]);
  if(scope.culture_ids?.length)await client.query(`INSERT INTO anomaly_subject_seen(culture_id) SELECT unnest($1::text[])
    ON CONFLICT(culture_id) DO UPDATE SET last_changed_at=now()`,[scope.culture_ids]);
  if(scope.isolate_ids?.length)await client.query(`INSERT INTO anomaly_isolate_seen(isolate_id) SELECT unnest($1::text[])
    ON CONFLICT(isolate_id) DO UPDATE SET last_changed_at=now()`,[scope.isolate_ids]);
}

export async function saveFindings(client:PoolClient,findings:AnomalyFinding[],filter:{quality?:boolean;ward?:string},ruleVersion:string){
  const existing=(await client.query(`SELECT * FROM anomaly_alerts WHERE ${filter.quality?"type='data_quality'":"type<>'data_quality' AND ward_code=$1"} FOR UPDATE`,filter.quality?[]:[filter.ward])).rows;
  const byFingerprint=new Map(existing.map(row=>[row.fingerprint,row])),matched=new Set<string>();let changed=0;
  for(const finding of findings){
    const old=byFingerprint.get(finding.fingerprint),id=old?.id||randomUUID(),hash=createHash('sha256').update(JSON.stringify({evidence:finding.evidence,records:finding.records,ruleVersion})).digest('hex');matched.add(finding.fingerprint);
    if(old?.active&&old.evidence_hash===hash){await client.query('UPDATE anomaly_alerts SET last_evaluated_at=now() WHERE id=$1',[id]);continue;}
    const reopened=old&&!old.active;
    await client.query(`INSERT INTO anomaly_alerts(id,fingerprint,type,code,source,ward_code,organism,specimen,antibiotic_code,flag,rule_version,evidence,evidence_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT(fingerprint) DO UPDATE SET active=true,status=CASE WHEN anomaly_alerts.active THEN anomaly_alerts.status ELSE 'open' END,
      episode=anomaly_alerts.episode+CASE WHEN anomaly_alerts.active THEN 0 ELSE 1 END,version=anomaly_alerts.version+1,
      first_detected_at=CASE WHEN anomaly_alerts.active THEN anomaly_alerts.first_detected_at ELSE now() END,
      last_detected_at=now(),last_evaluated_at=now(),resolved_at=NULL,rule_version=excluded.rule_version,evidence=excluded.evidence,evidence_hash=excluded.evidence_hash`,
    [id,finding.fingerprint,finding.type,finding.code,finding.source,finding.ward_code||null,finding.organism||null,finding.specimen||null,finding.antibiotic_code||null,finding.flag||null,ruleVersion,finding.evidence,hash]);
    await client.query('DELETE FROM anomaly_links WHERE alert_id=$1',[id]);
    if(finding.records.length)await client.query(`INSERT INTO anomaly_links(alert_id,kind,record_key,patient_id,culture_id,record)
      SELECT $1,r.kind,r.record_key,r.patient_id,r.culture_id,r.record FROM jsonb_to_recordset($2::jsonb) AS r(kind TEXT,record_key TEXT,patient_id TEXT,culture_id TEXT,record JSONB) ON CONFLICT DO NOTHING`,
    [id,JSON.stringify(finding.records.map(r=>({kind:r.record_kind||(r.isolate_id?'isolate':r.culture_id?'culture':'message'),record_key:r.record_key||r.isolate_id||r.culture_id||r.message_id,patient_id:r.patient_id||null,culture_id:r.culture_id||null,record:r})))]);
    const episode=old?old.episode+(reopened?1:0):1;
    await client.query('INSERT INTO anomaly_review_history(alert_id,episode,action,note,actor) VALUES($1,$2,$3,$4,$5)',[id,episode,old?reopened?'reopened':'evidence_updated':'detected','Criteria and evidence are saved with the rule version.','detector']);changed++;
  }
  for(const old of existing)if(old.active&&!matched.has(old.fingerprint)){
    await client.query("UPDATE anomaly_alerts SET active=false,status='resolved',version=version+1,resolved_at=now(),last_evaluated_at=now() WHERE id=$1",[old.id]);
    await client.query("INSERT INTO anomaly_review_history(alert_id,episode,action,note,actor) VALUES($1,$2,'resolved','Criteria no longer met; source correction, expiry or changed eligibility.','detector')",[old.id,old.episode]);changed++;
  }
  return changed;
}

export async function reviewAnomaly(pool:Pool,id:string,status:string,expectedVersion:number,note=''){
  const client=await pool.connect();try{
    await client.query('BEGIN');const row=(await client.query('SELECT * FROM anomaly_alerts WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!row)throw new AppError(404,'Alert not found');if(!row.active)throw new AppError(409,'This alert has already resolved');
    if(row.version!==expectedVersion)throw new AppError(409,'Alert changed. Refresh and review it again.');
    if(!['open','acknowledged','dismissed'].includes(status))throw new AppError(400,'Invalid review status');
    if(status==='dismissed'&&!note.trim())throw new AppError(400,'A dismissal note is required');
    if(status!==row.status){await client.query('UPDATE anomaly_alerts SET status=$2,version=version+1 WHERE id=$1',[id,status]);await client.query('INSERT INTO anomaly_review_history(alert_id,episode,action,note,actor) VALUES($1,$2,$3,$4,$5)',[id,row.episode,status,note.trim(),'local user']);}
    await client.query('COMMIT');return {id,status};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function assistantAnomalies(pool:Pool,scope:{patient_ids?:string[];culture_ids?:string[];ward_codes?:string[]},limit=5){
  const specific=!!(scope.patient_ids?.length||scope.culture_ids?.length||scope.ward_codes?.length);
  const rows=(await pool.query(`SELECT a.id,a.type,a.code,a.status,a.ward_code,a.organism,a.specimen,a.antibiotic_code,a.flag,a.evidence,a.rule_version,a.last_evaluated_at,
    count(*) OVER()::integer AS total FROM anomaly_alerts a WHERE a.active ${specific?`AND (a.ward_code=ANY($1::text[]) OR EXISTS(SELECT 1 FROM anomaly_links l WHERE l.alert_id=a.id AND (l.patient_id=ANY($2::text[]) OR l.culture_id=ANY($3::text[]))))`:''}
    ORDER BY CASE a.status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,a.last_detected_at DESC,a.id LIMIT ${specific?'$4':'$1'}`,specific?[scope.ward_codes||[],scope.patient_ids||[],scope.culture_ids||[],limit]:[limit])).rows;
  return {alerts:rows.map(({total,...row})=>row),omitted:Math.max(0,(rows[0]?.total||0)-rows.length),
    interpretation:'Saved statistical/data-quality surveillance signals, not diagnoses or confirmed outbreaks. Ward means sample location. Patient linkage means a record contributed to that group, not that the patient caused a cluster. Review status is distinct from whether criteria still hold. Do not infer treatment from an alert.'};
}
