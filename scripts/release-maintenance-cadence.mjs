import fs from 'node:fs';
import assert from 'node:assert/strict';
import {parseEnv} from 'node:util';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {assertProjectCredentials,schemaMigrationPlan,migrationFingerprintMatches} from './lib/database-migration-safety.mjs';

const mode=process.argv[2];
assert(['preflight','apply','verify'].includes(mode),'Choose preflight, apply or verify');
const env=parseEnv(fs.readFileSync('.env.local','utf8'));
const project='mjuluaqrvbnycisnarzi';
const target=assertProjectCredentials(env,project);
const item=schemaMigrationPlan().find(m=>m.name==='202611210001_veo_maintenance_cadence.sql');
assert(item,'Maintenance migration is missing');
const options={connectionString:env.DATABASE_POOLER_URL_5432||target.connectionString,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:8000,query_timeout:25000};
const db=new pg.Client(options);db.on('error',()=>{});
const report={at:new Date().toISOString(),mode,project,migration:item.name,sha256:item.sha256};
const originals=['veo_refresh_all_discipline()','veo_telegram_intake_maintenance()'];
const additions=['veo_claim_maintenance_phase(text,uuid)','veo_finish_maintenance_phase(text,uuid,boolean)','veo_maintenance_phase_status()'];
async function properties(){return(await db.query('SELECT oid::regprocedure::text signature,proowner,proacl,prosrc,prosecdef,proconfig,pg_get_function_arguments(oid) arguments FROM pg_proc WHERE oid=ANY($1::regprocedure[]) ORDER BY oid',[originals])).rows;}
async function scalar(expression,args=[]){return(await db.query('SELECT '+expression+' result',args)).rows[0].result;}
try{
 report.phase='connect';await db.connect();
 await db.query(mode==='verify'?'BEGIN READ ONLY':'BEGIN');
 await db.query("SET LOCAL statement_timeout='20s';SET LOCAL lock_timeout='3s'");
 const before=await properties();assert.equal(before.length,2);
 const installed=(await db.query('SELECT filename,sha256,project_ref FROM app_private.veobot_project_migrations WHERE filename=$1',[item.name])).rows[0];
 if(installed)assert(migrationFingerprintMatches(installed,item,project),'Installed migration differs from this release');
 else{
  assert.notEqual(mode,'verify','Migration is not installed');
  if(mode==='apply'){
   const receipt=JSON.parse(fs.readFileSync('.vercel/maintenance-cadence-preflight.json','utf8'));
   assert(receipt.passed&&receipt.project===project&&receipt.sha256===item.sha256&&Date.now()-Date.parse(receipt.at)<3600000,'A matching successful preflight is required');
  }
  assert.equal(await scalar("pg_try_advisory_xact_lock(hashtext('veobot_project_schema_install'))"),true,'Another schema installation is active');
  report.phase='migration';await db.query(item.sql);
  await db.query('INSERT INTO app_private.veobot_project_migrations(filename,sha256,project_ref) VALUES($1,$2,$3)',[item.name,item.sha256,project]);
 }
 report.phase='function-properties';
 const after=await properties();
 for(let i=0;i<before.length;i++){
  for(const key of ['signature','proowner','proacl','prosrc','prosecdef','arguments'])assert.deepEqual(after[i][key],before[i][key],'Existing maintenance behavior and permissions must stay unchanged');
  assert(after[i].proconfig.includes('statement_timeout=5s')&&after[i].proconfig.includes('lock_timeout=1s'));
  const retained=settings=>(settings||[]).filter(v=>!v.startsWith('statement_timeout=')&&!v.startsWith('lock_timeout=')&&!(after[i].signature.startsWith('veo_telegram_intake_maintenance(')&&v.startsWith('jit='))).sort();
  assert.deepEqual(retained(after[i].proconfig),retained(before[i].proconfig));
 }
 for(const signature of additions){
  const row=(await db.query("SELECT prosecdef,proconfig,has_function_privilege('anon',oid,'EXECUTE') anon,has_function_privilege('authenticated',oid,'EXECUTE') authenticated,has_function_privilege('service_role',oid,'EXECUTE') service FROM pg_proc WHERE oid=$1::regprocedure",[signature])).rows[0];
  assert(row.prosecdef&&row.proconfig.includes('statement_timeout=2s'));
  assert(!row.anon&&!row.authenticated&&row.service);
 }
 assert.equal(await scalar("has_table_privilege('service_role','app_private.veo_maintenance_phases','INSERT,UPDATE,DELETE')"),false);
 if(mode==='preflight'&&!installed){
  report.phase='rolled-back-recovery-check';
  const owner=randomUUID(),other=randomUUID();
  assert.equal(await scalar("veo_claim_maintenance_phase('salary',$1)",[owner]),true);
  assert.equal(await scalar("veo_claim_maintenance_phase('salary',$1)",[other]),false);
  assert.equal(await scalar("veo_finish_maintenance_phase('salary',$1,true)",[other]),false);
  assert.equal(await scalar("veo_finish_maintenance_phase('salary',$1,true)",[owner]),true);
  assert.equal(await scalar("veo_claim_maintenance_phase('salary',$1)",[other]),false);
  await db.query("UPDATE app_private.veo_maintenance_phases SET next_run_at=now()-interval '1 second',leased_until=now()-interval '1 second'");
  assert.equal(await scalar("veo_claim_maintenance_phase('salary',$1)",[other]),true);
  assert.equal(await scalar("veo_finish_maintenance_phase('salary',$1,false)",[other]),true);
  const state=await scalar('veo_maintenance_phase_status()');
  assert.equal(state.healthy,false);assert.equal(state.phases.find(p=>p.phase==='salary').failures,1);
  report.recovery_check_rolled_back=true;
 }
 report.phase='finish';await db.query(mode==='apply'?'COMMIT':'ROLLBACK');
 if(mode==='verify'){
  // Hold only an advisory lock. The other read-only transaction must return
  // immediately without writing metadata or invoking a maintenance worker.
  const peer=new pg.Client(options);peer.on('error',()=>{});
  try{
   await peer.connect();await db.query('BEGIN');await peer.query('BEGIN READ ONLY');
   for(const phase of ['salary','operations']){
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('veo-maintenance-phase:'||$1,0))",[phase]);
    const started=Date.now();const claimed=await peer.query('SELECT veo_claim_maintenance_phase($1,$2) claimed',[phase,randomUUID()]);
    assert.equal(claimed.rows[0].claimed,false);assert(Date.now()-started<2000,'Busy admission must not wait for maintenance');
   }
   report.cross_connection_denial_verified=true;
  }finally{await peer.query('ROLLBACK').catch(()=>{});await db.query('ROLLBACK').catch(()=>{});await peer.end().catch(()=>{});}
 }
 report.function_bodies_and_permissions_preserved=true;report.passed=true;
}catch(error){await db.query('ROLLBACK').catch(()=>{});report.passed=false;report.error=error.message;report.code=error.code;process.exitCode=1;}
finally{
 await db.end().catch(()=>{});fs.mkdirSync('.vercel',{recursive:true});
 fs.writeFileSync('.vercel/maintenance-cadence-'+mode+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
