// Only the reviewed Page recovery schema is applied. No artificial customer,
// message, stage, receipt or payment is created by migration verification.
import fs from 'node:fs';import assert from 'node:assert/strict';import pg from 'pg';
import {assertProjectCredentials,assertSchemaDestination,schemaMigrationPlan,migrationFingerprintMatches} from './lib/database-migration-safety.mjs';
import {migrationConnectionOptions} from './lib/migration-retry.mjs';
const mode=process.argv.includes('--apply')?'apply':process.argv.includes('--preflight')?'preflight':null;
assert(mode&&!(process.argv.includes('--apply')&&process.argv.includes('--preflight')),'Choose --preflight or --apply');
const project=new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0];assertSchemaDestination(project);
const migration=schemaMigrationPlan().find(m=>m.name==='202611110004_veo_autotag_page_recovery.sql');assert(migration,'Reviewed auto-tag schema missing');
const db=new pg.Client({...await migrationConnectionOptions(assertProjectCredentials(process.env,project).connectionString),connectionTimeoutMillis:10000,query_timeout:45000});db.on('error',()=>{});
const report={at:new Date().toISOString(),mode,project,migration:migration.name,applied:false,messagesSent:0,financialRecordsCreated:0};
const snapshot=async()=>(await db.query(`SELECT
 (SELECT count(*)::int FROM contacts) contacts,(SELECT count(*)::int FROM contact_tags) tags,
 (SELECT count(*)::int FROM messenger_lead_stage_events) stage_events,
 (SELECT count(*)::int FROM veo_orders) orders,(SELECT count(*)::int FROM veo_payments) payments,(SELECT count(*)::int FROM veo_receipts) receipts,
 (SELECT count(*)::int FROM veo_salary_days) salary_days,(SELECT count(*)::int FROM user_pages) page_grants,
 (SELECT jsonb_agg(jsonb_build_object('id',id,'is_active',is_active) ORDER BY id) FROM users) users,
 (SELECT jsonb_agg(jsonb_build_object('id',id,'launch',launch_at) ORDER BY id) FROM veo_tenants) launch_cutoffs`)).rows[0];
try{
 await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await db.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='30s'");
 assert((await db.query("SELECT pg_try_advisory_xact_lock(hashtext('veobot_project_schema_install')) locked")).rows[0].locked,'Schema installer busy');
 const before=await snapshot(),recorded=(await db.query('SELECT filename,sha256,project_ref FROM app_private.veobot_project_migrations WHERE filename=$1',[migration.name])).rows[0];
 if(recorded)assert(migrationFingerprintMatches(recorded,migration,project),'Installed auto-tag fingerprint differs');
 else{
  await db.query(migration.sql);await db.query('INSERT INTO app_private.veobot_project_migrations(filename,sha256,project_ref) VALUES($1,$2,$3)',[migration.name,migration.sha256,project]);
  const tracking=(await db.query("SELECT to_regclass('app_private.schema_migrations') IS NOT NULL app,to_regclass('supabase_migrations.schema_migrations') IS NOT NULL supabase")).rows[0];
  if(tracking.app)await db.query('INSERT INTO app_private.schema_migrations(version,description) VALUES($1,$2) ON CONFLICT(version) DO NOTHING',['202611110004',migration.name]);
  if(tracking.supabase)await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3::text[]) ON CONFLICT(version) DO NOTHING',['202611110004','veo_autotag_page_recovery',[migration.sql]]);
 }
 assert.deepEqual(await snapshot(),before,'Existing data changed during schema application');
 for(const fn of ['veo_claim_autotag_pages(integer)','veo_finish_autotag_page(uuid,uuid,jsonb)','veo_repair_autotag_history(uuid,integer)','veo_autotag_status(uuid)'])assert.equal((await db.query("SELECT has_function_privilege('anon',$1,'EXECUTE') OR has_function_privilege('authenticated',$1,'EXECUTE') exposed",[fn])).rows[0].exposed,false);
 await db.query(mode==='apply'?'COMMIT':'ROLLBACK');report.applied=mode==='apply'&&!recorded;report.retainedDataPreserved=true;report.passed=true;
}catch(error){await db.query('ROLLBACK').catch(()=>{});report.passed=false;report.error=error.message;process.exitCode=1;}
finally{await db.end();fs.mkdirSync('.vercel',{recursive:true});fs.writeFileSync('.vercel/autotag-schema-'+mode+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
