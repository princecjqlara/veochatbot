// Applies only the reviewed login/team repair. It supplies no credentials,
// changes no existing account, and sends no messages.
import fs from 'node:fs';import assert from 'node:assert/strict';import pg from 'pg';
import {assertProjectCredentials,assertSchemaDestination,schemaMigrationPlan,migrationFingerprintMatches,VEO_RECOVERY_PROJECT} from './lib/database-migration-safety.mjs';
import {migrationConnectionOptions} from './lib/migration-retry.mjs';
const mode=process.argv.includes('--apply')?'apply':process.argv.includes('--preflight')?'preflight':null;
assert(mode&&!(process.argv.includes('--apply')&&process.argv.includes('--preflight')),'Choose --preflight or --apply');
const project=new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0];assertSchemaDestination(project);
assert.equal(project,VEO_RECOVERY_PROJECT,'This repair targets only the fresh recovery project');
const conflict=process.argv.includes('--direct-member-conflicts'),direct=process.argv.includes('--direct-members')||conflict,name=conflict?'202611110007_veo_supervisor_conflict_response.sql':direct?'202611110006_veo_direct_member_supervision.sql':'202611110005_veo_account_access_and_supervisor_teams.sql';
const migration=schemaMigrationPlan().find(m=>m.name===name);assert(migration,'Reviewed account access schema missing');
const db=new pg.Client({...await migrationConnectionOptions(assertProjectCredentials(process.env,project).connectionString),connectionTimeoutMillis:30000,query_timeout:45000});db.on('error',()=>{});
const report={at:new Date().toISOString(),mode,project,migration:migration.name,applied:false,messagesSent:0,passwordsChanged:0};
const snapshot=async()=>(await db.query(`SELECT
 (SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM users u) users,
 (SELECT jsonb_agg(to_jsonb(a) ORDER BY user_id) FROM veo_accounts a) accounts,
 (SELECT jsonb_agg(to_jsonb(g) ORDER BY user_id,page_id) FROM user_pages g) grants,
 (SELECT count(*)::int FROM contacts) contacts,(SELECT count(*)::int FROM contact_tags) tags,
 (SELECT count(*)::int FROM veo_orders) orders,(SELECT count(*)::int FROM veo_payments) payments,
 (SELECT count(*)::int FROM veo_receipts) receipts,(SELECT count(*)::int FROM veo_salary_days) salaries,
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM veo_tenants t) tenants`)).rows[0];
try{
 await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await db.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='30s'");
 assert((await db.query("SELECT pg_try_advisory_xact_lock(hashtext('veobot_project_schema_install')) locked")).rows[0].locked,'Schema installer busy');
 const before=await snapshot(),teams=(await db.query('SELECT * FROM veo_teams ORDER BY id')).rows;
 const missing=(await db.query("SELECT a.user_id FROM veo_accounts a WHERE a.active AND a.departed_at IS NULL AND a.role IN('team_leader','manager') AND NOT EXISTS(SELECT 1 FROM veo_teams t WHERE t.manager_id=a.user_id)")).rows;
 const recorded=(await db.query('SELECT filename,sha256,project_ref FROM app_private.veobot_project_migrations WHERE filename=$1',[migration.name])).rows[0];
 if(recorded)assert(migrationFingerprintMatches(recorded,migration,project),'Installed account access fingerprint differs');
 else{
  await db.query(migration.sql);await db.query('INSERT INTO app_private.veobot_project_migrations(filename,sha256,project_ref) VALUES($1,$2,$3)',[migration.name,migration.sha256,project]);
  const tracking=(await db.query("SELECT to_regclass('app_private.schema_migrations') IS NOT NULL app,to_regclass('supabase_migrations.schema_migrations') IS NOT NULL supabase")).rows[0];
  const version=conflict?'202611110007':direct?'202611110006':'202611110005';
  if(tracking.app)await db.query('INSERT INTO app_private.schema_migrations(version,description) VALUES($1,$2) ON CONFLICT(version) DO NOTHING',[version,migration.name]);
  if(tracking.supabase)await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3::text[]) ON CONFLICT(version) DO NOTHING',[version,conflict?'veo_supervisor_conflict_response':direct?'veo_direct_member_supervision':'veo_account_access_and_supervisor_teams',[migration.sql]]);
 }
 assert(JSON.stringify(await snapshot())===JSON.stringify(before),'Existing account, grant or retained business data changed');
 const afterTeams=(await db.query('SELECT * FROM veo_teams ORDER BY id')).rows;
 assert(JSON.stringify(afterTeams.filter(t=>teams.some(o=>o.id===t.id)))===JSON.stringify(teams),'Existing team changed');
 assert.equal(afterTeams.length,teams.length+missing.length);
 for(const fn of ['veo_account_access(uuid)','veo_recover_account_login(uuid,uuid,text,text)','veo_set_account_password(uuid,uuid,text)'])assert.equal((await db.query("SELECT has_function_privilege('anon',$1,'EXECUTE') OR has_function_privilege('authenticated',$1,'EXECUTE') exposed",[fn])).rows[0].exposed,false);
 if(direct)assert.equal((await db.query("SELECT has_function_privilege('anon','veo_change_member_supervisor(uuid,uuid,uuid,uuid)','EXECUTE') OR has_function_privilege('authenticated','veo_change_member_supervisor(uuid,uuid,uuid,uuid)','EXECUTE') exposed")).rows[0].exposed,false);
 await db.query(mode==='apply'?'COMMIT':'ROLLBACK');Object.assign(report,{applied:mode==='apply'&&!recorded,missingSupervisorTeams:missing.length,existingDataPreserved:true,passed:true});
}catch(error){await db.query('ROLLBACK').catch(()=>{});report.passed=false;report.error=error.message;process.exitCode=1;}
finally{await db.end();fs.mkdirSync('.vercel',{recursive:true});fs.writeFileSync('.vercel/'+(conflict?'direct-member-conflict-schema-':direct?'direct-member-schema-':'account-access-schema-')+mode+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
