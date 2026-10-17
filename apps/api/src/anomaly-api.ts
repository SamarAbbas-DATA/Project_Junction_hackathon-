import type { FastifyInstance } from 'fastify';
import type { HubStore } from './hub-store.js';
import type { Row } from './source-store.js';
import { AppError } from './config.js';
import { anomalyRules } from './anomaly-detector.js';
import { reviewAnomaly } from './anomaly-store.js';

export function registerAnomalies(app:FastifyInstance,hub:HubStore){
  const query={type:'object',additionalProperties:false,properties:{status:{enum:['active','all','open','acknowledged','dismissed','resolved']},type:{enum:['resistance','cluster','data_quality']},ward:{type:'string',maxLength:150},q:{type:'string',maxLength:150},limit:{type:'integer',minimum:1,maximum:100},offset:{type:'integer',minimum:0},from:{type:'string',format:'date'},to:{type:'string',format:'date'}}};
  app.get('/api/anomalies',{schema:{querystring:query}},async request=>{
    const q=request.query as Row,values:any[]=[],where:string[]=[];
    const bind=(value:unknown)=>{values.push(value);return '$'+values.length;};
    if(!q.status||q.status==='active')where.push("a.active AND a.status<>'dismissed'");else if(q.status!=='all')where.push('a.status='+bind(q.status));
    if(q.type)where.push('a.type='+bind(q.type));if(q.ward)where.push('a.ward_code='+bind(q.ward));
    if(q.from)where.push('a.first_detected_at>='+bind(q.from)+'::date');if(q.to)where.push('a.first_detected_at<('+bind(q.to)+"::date+interval '1 day')");
    if(q.from&&q.to&&q.from>q.to)throw new AppError(400,'Start date must not follow end date');
    if(q.q){const escaped='%'+String(q.q).replace(/[\\%_]/g,'\\$&')+'%',param=bind(escaped);where.push(`(a.organism ILIKE ${param} OR a.ward_code ILIKE ${param} OR a.antibiotic_code ILIKE ${param} OR a.flag ILIKE ${param} OR EXISTS(SELECT 1 FROM anomaly_links l WHERE l.alert_id=a.id AND (l.patient_id ILIKE ${param} OR l.culture_id ILIKE ${param} OR l.record_key ILIKE ${param})))`);}
    const clause=where.length?' WHERE '+where.join(' AND '):'';
    const total=(await hub.pool.query('SELECT count(*)::integer AS n FROM anomaly_alerts a'+clause,values)).rows[0].n;
    const rows=(await hub.pool.query(`SELECT a.*,w.ward_en,w.ward_fi FROM anomaly_alerts a LEFT JOIN adt.wards w USING(ward_code) ${clause}
      ORDER BY a.active DESC,CASE a.status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,a.last_detected_at DESC,a.id LIMIT ${bind(q.limit||25)} OFFSET ${bind(q.offset||0)}`,values)).rows;
    return {rows,total,limit:q.limit||25,offset:q.offset||0};
  });
  app.get('/api/anomalies/summary',async()=>{
    const counts=(await hub.pool.query(`SELECT count(*) FILTER(WHERE active AND status<>'dismissed')::integer AS active,
      count(*) FILTER(WHERE status='open')::integer AS open,count(*) FILTER(WHERE status='acknowledged')::integer AS acknowledged,
      count(*) FILTER(WHERE status='dismissed')::integer AS dismissed,count(*) FILTER(WHERE status='resolved')::integer AS resolved,
      count(*) FILTER(WHERE active AND status<>'dismissed' AND type='resistance')::integer AS resistance,
      count(*) FILTER(WHERE active AND status<>'dismissed' AND type='cluster')::integer AS cluster,
      count(*) FILTER(WHERE active AND status<>'dismissed' AND type='data_quality')::integer AS data_quality FROM anomaly_alerts`)).rows[0];
    const jobs=(await hub.pool.query('SELECT scope_key,attempts,error,run_after FROM anomaly_jobs WHERE generation>processed_generation ORDER BY scope_key')).rows;
    const evaluated=(await hub.pool.query('SELECT max(completed_at) AS at FROM anomaly_evaluations')).rows[0].at;
    const wards=(await hub.pool.query('SELECT ward_code,ward_en,ward_fi FROM adt.wards ORDER BY ward_code')).rows;
    const recent=(await hub.pool.query('SELECT scope_key,as_of::text,statistics,completed_at FROM (SELECT DISTINCT ON(scope_key) * FROM anomaly_evaluations ORDER BY scope_key,id DESC) latest ORDER BY scope_key')).rows;
    return {counts,jobs,last_evaluated_at:evaluated,sources:Object.values(hub.sourceStatus),rules:anomalyRules,wards,evaluations:recent,demo_enabled:process.env.ANOMALY_DEMO_ENABLED!=='false'&&process.env.NODE_ENV!=='production'};
  });
  app.get('/api/anomalies/:id',{schema:{params:{type:'object',required:['id'],properties:{id:{type:'string',format:'uuid'}}}}},async request=>{
    const {id}=request.params as Row,row=(await hub.pool.query('SELECT a.*,w.ward_en,w.ward_fi FROM anomaly_alerts a LEFT JOIN adt.wards w USING(ward_code) WHERE a.id=$1',[id])).rows[0];
    if(!row)throw new AppError(404,'Alert not found');
    const [links,total,history]=await Promise.all([
      hub.pool.query('SELECT record FROM anomaly_links WHERE alert_id=$1 ORDER BY kind,record_key LIMIT 100',[id]),
      hub.pool.query('SELECT count(*)::integer AS n FROM anomaly_links WHERE alert_id=$1',[id]),
      hub.pool.query('SELECT episode,action,note,actor,at FROM anomaly_review_history WHERE alert_id=$1 ORDER BY id DESC LIMIT 100',[id])]);
    return {...row,records:links.rows.map(r=>r.record),records_total:total.rows[0].n,history:history.rows};
  });
  app.patch('/api/anomalies/:id/review',{schema:{params:{type:'object',required:['id'],properties:{id:{type:'string',format:'uuid'}}},body:{type:'object',additionalProperties:false,required:['status','expected_version'],properties:{status:{enum:['open','acknowledged','dismissed']},expected_version:{type:'integer',minimum:1},note:{type:'string',maxLength:1000}}}}},async request=>{
    const {id}=request.params as Row,input=request.body as Row;
    const saved=await reviewAnomaly(hub.pool,id,input.status,input.expected_version,input.note||'');hub.onChange({type:'anomalies.updated',alert_id:id});return saved;
  });
}
