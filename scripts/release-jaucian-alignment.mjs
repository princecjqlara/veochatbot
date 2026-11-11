// Applies only the reviewed sync bootstrap. The ordinary cron performs sync;
// this release never activates staff, maps identities or dispatches Telegram.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
import {assertProjectCredentials,assertSchemaDestination,schemaMigrationPlan,migrationFingerprintMatches} from './lib/database-migration-safety.mjs';
import {migrationConnectionOptions} from './lib/migration-retry.mjs';
const mode=process.argv.includes('--apply')?'apply':process.argv.includes('--preflight')?'preflight':null;
assert(mode && !(process.argv.includes('--apply')&&process.argv.includes('--preflight')),'Choose --preflight or --apply');
const project=new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0];assertSchemaDestination(project);
const endpoint=assertProjectCredentials(process.env,project),migration=schemaMigrationPlan().find(m=>m.name==='202611110003_veo_telegram_sync_bootstrap.sql');
assert(migration,'Reviewed Telegram sync bootstrap is required');
const db=new pg.Client({...await migrationConnectionOptions(endpoint.connectionString),connectionTimeoutMillis:10000,query_timeout:45000});
db.on('error',()=>{});
const report={at:new Date().toISOString(),mode,project,migration:migration.name,applied:false,telegramMessagesSent:0,staffActivated:0,identitiesMapped:0};
const inventory=async()=>(await db.query(`SELECT
 (SELECT jsonb_agg(to_jsonb(u) ORDER BY u.id) FROM (SELECT id,is_active FROM users) u) AS activation,
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM (SELECT id,launch_at FROM veo_tenants)t) AS cutoffs,
 (SELECT count(*)::int FROM contacts) AS contacts,(SELECT count(*)::int FROM user_pages) AS page_grants,
 (SELECT count(*)::int FROM veo_worker_mappings) AS worker_mappings,
 (SELECT count(*)::int FROM veo_telegram_memberships) AS memberships,
 (SELECT count(*)::int FROM veo_orders) AS orders,(SELECT count(*)::int FROM veo_payments) AS payments,
 (SELECT count(*)::int FROM veo_receipts) AS receipts,(SELECT count(*)::int FROM veo_salary_days) AS salary_days`)).rows[0];
try{
 await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await db.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='30s'");
 assert((await db.query("SELECT pg_try_advisory_xact_lock(hashtext('veobot_project_schema_install')) locked")).rows[0].locked,'Another schema installer is running');
 const before=await inventory(),recorded=(await db.query('SELECT filename,sha256,project_ref FROM app_private.veobot_project_migrations WHERE filename=$1',[migration.name])).rows[0];
 if(recorded)assert(migrationFingerprintMatches(recorded,migration,project),'Installed bootstrap fingerprint differs');
 else{
  await db.query(migration.sql);
  await db.query('INSERT INTO app_private.veobot_project_migrations(filename,sha256,project_ref) VALUES($1,$2,$3)',[migration.name,migration.sha256,project]);
  const tracking=(await db.query("SELECT to_regclass('app_private.schema_migrations') IS NOT NULL app,to_regclass('supabase_migrations.schema_migrations') IS NOT NULL supabase")).rows[0];
  if(tracking.app)await db.query('INSERT INTO app_private.schema_migrations(version,description) VALUES($1,$2) ON CONFLICT(version) DO NOTHING',['202611110003',migration.name]);
  if(tracking.supabase)await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3::text[]) ON CONFLICT(version) DO NOTHING',['202611110003','veo_telegram_sync_bootstrap',[migration.sql]]);
 }
 assert.deepEqual(await inventory(),before,'Retained data changed during bootstrap');
 assert.equal((await db.query('SELECT count(*)::int n FROM veo_tenants t WHERE t.launch_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM veo_telegram_sync_state s WHERE s.tenant_id=t.id)')).rows[0].n,0);
 const access=(await db.query("SELECT has_function_privilege('anon','veo_claim_telegram_sync()','EXECUTE') OR has_function_privilege('authenticated','veo_claim_telegram_sync()','EXECUTE') exposed")).rows[0];assert.equal(access.exposed,false);
 await db.query(mode==='apply'?'COMMIT':'ROLLBACK');report.applied=mode==='apply'&&!recorded;report.retainedDataPreserved=true;report.syncConfigured=true;report.passed=true;
}catch(error){await db.query('ROLLBACK').catch(()=>{});report.passed=false;report.error=error.message;process.exitCode=1;}
finally{await db.end();fs.mkdirSync('.vercel',{recursive:true});fs.writeFileSync('.vercel/jaucian-alignment-schema-'+mode+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
