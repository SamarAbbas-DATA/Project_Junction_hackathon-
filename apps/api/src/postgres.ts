import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { dataDir } from './config.js';

function executable(name: string) {
  if (process.env.POSTGRES_BIN) return path.join(process.env.POSTGRES_BIN, name + (process.platform==='win32' ? '.exe' : ''));
  if (process.platform !== 'win32') return name;
  const base = 'C:/Program Files/PostgreSQL';
  const versions = fs.existsSync(base) ? fs.readdirSync(base).sort((a,b)=>Number(b)-Number(a)) : [];
  const found = versions.map(v=>path.join(base,v,'bin',`${name}.exe`)).find(p=>fs.existsSync(p));
  if (!found) throw new Error('PostgreSQL binaries not found. Set DATABASE_URL or POSTGRES_BIN; see README.md.');
  return found;
}
const clusterDir = path.join(dataDir,'hub-postgres');
// pg_ctl launches a long-lived child. Inherited pipe handles can keep
// execFileSync waiting on Windows even after pg_ctl has exited.
const run = (name:string,args:string[]) => execFileSync(executable(name),args,{windowsHide:true,stdio:'ignore',encoding:'utf8',timeout:120000});
export async function startPostgres() {
  if (process.env.DATABASE_URL) return new pg.Pool({ connectionString:process.env.DATABASE_URL, max:5 });
  fs.mkdirSync(dataDir,{recursive:true});
  if (!fs.existsSync(path.join(clusterDir,'PG_VERSION'))) {
    console.log('Creating isolated PostgreSQL cluster on 127.0.0.1:55432…');
    run('initdb',['-D',clusterDir,'-U','amr_hub','-A','trust','--encoding=UTF8','--locale=C']);
  }
  try { run('pg_ctl',['-D',clusterDir,'status']); }
  catch { run('pg_ctl',['-D',clusterDir,'-l',path.join(dataDir,'postgres.log'),'-o','-h 127.0.0.1 -p 55432','-w','start']); }
  const config = {host:'127.0.0.1',port:55432,user:'amr_hub'};
  const admin = new pg.Client({...config,database:'postgres'});
  await admin.connect();
  try { if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='hub_db'")).rowCount) await admin.query('CREATE DATABASE hub_db'); }
  finally { await admin.end(); }
  return new pg.Pool({...config,database:'hub_db',max:5});
}
export function stopPostgres() {
  if (fs.existsSync(path.join(clusterDir,'PG_VERSION'))) console.log(run('pg_ctl',['-D',clusterDir,'-m','fast','-w','stop']));
}
if (process.argv.includes('--stop')) stopPostgres();
