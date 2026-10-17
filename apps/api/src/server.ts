import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import { SourceStore, type Row } from './source-store.js';
import { createSourceApi } from './source-api.js';
import { importData } from './import-data.js';
import { dataDir,sourceNames,ports,hubPort,syncInterval,AppError,type SourceName } from './config.js';
import { tables } from './catalog.js';
import { startPostgres } from './postgres.js';
import { HubStore,sourceHeaders } from './hub-store.js';
import { chat,commitProposal,models,executeTool,tools } from './chat.js';
import type { ServerResponse } from 'node:http';
import { watchDemoInbox } from './demo-import.js';
import { Predictor,registerPredictor } from './predictor.js';
import { registerAssistant } from './assistant.js';
import { migrateSyntheticIdentifiers } from './migrate-synthetic-identifiers.js';
import path from 'node:path';
import { root } from './config.js';
import { replayCompletedDemo } from './demo-replay.js';
import { bootstrapMessages } from './fhir-mapping.js';
import { startFhirSender } from './fhir-source.js';
import { registerFhirIntake } from './fhir-intake.js';
import { AnomalyDetector } from './anomaly-detector.js';
import { registerAnomalies } from './anomaly-api.js';
import { AnomalyDemoService,registerAnomalyDemo } from './anomaly-demo.js';

const stores=Object.fromEntries(sourceNames.map(source=>[source,new SourceStore(source,dataDir)]));
importData(stores);
const renamed=migrateSyntheticIdentifiers(stores,dataDir);
if(renamed.changed)console.log(`Hospital identifiers: ${renamed.patients} synthetic patients and ${renamed.changed} linked records updated. Backup: ${renamed.backup}`);
const inboxPath=process.env.SYNTHETIC_INBOX||path.join(root,'output','data','inbox');
const replay=process.env.SYNTHETIC_AUTO_IMPORT!=='false'&&process.env.SYNTHETIC_REPLAY_ON_RESTART!=='false'?replayCompletedDemo(stores,dataDir,inboxPath):null;
if(replay?.reset)console.log(`Demo replay: cleared ${replay.patients} generated patients and their linked records; ${replay.protected_patients} patients protected by additional records. Backup: ${replay.backup}`);
const sourceApps:Awaited<ReturnType<typeof createSourceApi>>[]=[];
for(const source of sourceNames){
  const app=await createSourceApi(stores[source]);
  await app.listen({host:'127.0.0.1',port:ports[source]});sourceApps.push(app);
  console.log(`${source.toUpperCase()} API: http://127.0.0.1:${ports[source]}/docs`);
}
const pool=await startPostgres();
const hub=new HubStore(pool);hub.initialMessages=source=>bootstrapMessages(stores[source]);await hub.initialize();
const app=Fastify({logger:false,bodyLimit:5*1024*1024});
await app.register(cors,{origin:['http://127.0.0.1:5173','http://localhost:5173']});
await app.register(swagger,{openapi:{info:{title:'AMR Hub application API',version:'1.0.0'}}});
await app.register(swaggerUI,{routePrefix:'/docs'});
app.setErrorHandler((error,request,reply)=>{
  const e=error as any;const status=e.statusCode||500;
  if(status>=500)console.error(e);
  reply.code(status).send({error:status>=500&&!(e instanceof AppError)?'Request failed. Check backend logs.':e.message});
});
const clients=new Set<ServerResponse>();
hub.onChange=event=>{for(const client of clients)client.write(`data: ${JSON.stringify({...event,at:new Date().toISOString()})}\n\n`);};
app.get('/api/health',async()=>({status:Object.values(hub.sourceStatus).every(s=>s.status==='connected')?'ok':'initializing',database:'PostgreSQL',sources:hub.sourceStatus}));
app.get('/api/catalog',async()=>({tables,sources:sourceNames.map(source=>({source,port:ports[source],database:`${source}_db.sqlite`}))}));
app.get('/api/overview',async()=>hub.overview());
const predictor=new Predictor();
registerPredictor(app,hub,predictor);
registerAssistant(app,hub,predictor);
registerFhirIntake(app,hub);
registerAnomalies(app,hub);
registerAnomalyDemo(app,new AnomalyDemoService(hub,stores));
app.get('/api/sources',async()=>({sources:Object.values(hub.sourceStatus)}));
app.post('/api/sync',async()=>{await hub.sync();return {sources:Object.values(hub.sourceStatus)};});
app.get('/api/activity',async request=>{
  const q=request.query as Row;const limit=Math.min(Math.max(Number(q.limit)||30,1),100);
  return {events:(await pool.query('SELECT * FROM event_log ORDER BY id DESC LIMIT $1',[limit])).rows};
});
app.get('/api/antibiogram',async request=>{
  const q=request.query as Row;
  for(const field of ['from','to'])if(q[field]&&!/^\d{4}-\d{2}-\d{2}$/.test(q[field]))throw new AppError(400,'Dates must use YYYY-MM-DD');
  if(q.from&&q.to&&q.from>q.to)throw new AppError(400,'Start date must not follow end date');
  return hub.antibiogram(q);
});
app.get('/api/patients',async request=>hub.patients(request.query as Row));
app.get('/api/patients/:id/history',async request=>{
  const data=await hub.patientHistory((request.params as Row).id);
  if(!data)throw new AppError(404,'Patient not found');
  return data;
});
app.get('/api/events',async(request,reply)=>{
  reply.hijack();reply.raw.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive','x-accel-buffering':'no'});
  reply.raw.write(`data: ${JSON.stringify({type:'connected'})}\n\n`);clients.add(reply.raw);
  const heartbeat=setInterval(()=>reply.raw.write(': heartbeat\n\n'),15000);
  request.raw.on('close',()=>{clearInterval(heartbeat);clients.delete(reply.raw);});
});
// Browser calls the hub; only this fixed allowlist can reach source APIs.
app.route({method:['GET','POST','PATCH'],url:'/api/source/:source/:table',handler:proxy});
app.route({method:['GET','PATCH'],url:'/api/source/:source/:table/:id',handler:proxy});
async function proxy(request:any,reply:any){
  const {source,table,id}=request.params;
  if(!tables.some(t=>t.source===source&&t.name===table))throw new AppError(404,'Unknown source table');
  if(request.method==='GET')return id!==undefined?hub.record(source,table,id):hub.records(source,table,request.query||{});
  const url=new URL(`http://127.0.0.1:${ports[source as SourceName]}/${table}${id!==undefined?'/'+encodeURIComponent(id):''}`);
  for(const [key,value]of Object.entries(request.query||{}))url.searchParams.set(key,String(value));
  const headers:Record<string,string>={...sourceHeaders()};
  if(request.body)headers['content-type']='application/json';
  for(const h of ['if-match','idempotency-key'])if(request.headers[h])headers[h]=String(request.headers[h]);
  const response=await fetch(url,{method:request.method,headers,body:request.body?JSON.stringify(request.body):undefined,signal:AbortSignal.timeout(10000)}).catch(()=>{throw new AppError(503,'The requested source is unavailable');});
  const body=await response.json();
  if(response.ok&&request.method!=='GET')void hub.sync();
  return reply.code(response.status).send(body);
}
app.get('/api/chat/models',async()=>models());
app.get('/api/chat/tools',async()=>({tools}));
app.post('/api/chat',async request=>chat(hub,request.body as Row));
app.post('/api/proposals/:id/commit',async request=>{const result=await commitProposal(hub,(request.params as Row).id);void hub.sync();return result;});
await app.listen({host:'127.0.0.1',port:hubPort});
console.log(`AMR Hub API: http://127.0.0.1:${hubPort}/docs`);
await hub.sync();
if(replay?.reset){
  const targets=Object.fromEntries(sourceNames.map(source=>[source,Number((stores[source].db.prepare('SELECT coalesce(max(event_id),0) AS n FROM events').get() as Row).n)]));
  // Drain delete events before the first new arrival, including large batches.
  while(sourceNames.some(source=>hub.sourceStatus[source].status==='connected'&&hub.sourceStatus[source].cursor<targets[source]))await hub.sync();
}
console.log('Initial synchronization complete. React app: http://127.0.0.1:5173');
const anomalyDetector=new AnomalyDetector(hub);await anomalyDetector.start();
const senders=sourceNames.map(source=>startFhirSender(stores[source],`http://127.0.0.1:${hubPort}/api/intake/fhir`,Number(hub.sourceStatus[source].cursor)||0));
const demoInbox=process.env.SYNTHETIC_AUTO_IMPORT==='false'?null:watchDemoInbox();
if(demoInbox)console.log(`Synthetic CSV inbox: ${demoInbox.directory} · ${demoInbox.groupSize} patient(s) every ${demoInbox.intervalMs/1000}s, with staged laboratory results`);
const timer=setInterval(()=>void hub.sync(),syncInterval);
let shuttingDown=false;
async function shutdown(){
  if(shuttingDown)return;shuttingDown=true;clearInterval(timer);for(const client of clients)client.end();
  await demoInbox?.stop();
  await anomalyDetector.stop();
  for(const sender of senders)await sender.stop();
  await app.close();for(const source of sourceApps)await source.close();
  while(hub.syncing)await new Promise(r=>setTimeout(r,50));
  await pool.end();Object.values(stores).forEach(s=>s.close());process.exit(0);
}
process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());
