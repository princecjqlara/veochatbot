import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import pg from 'pg';
import {assertProjectCredentials,VEO_RECOVERY_PROJECT,schemaMigrationPlan,migrationFingerprintMatches} from './lib/database-migration-safety.mjs';
import {migrationConnectionOptions} from './lib/migration-retry.mjs';
createRequire(import.meta.url)('@next/env').loadEnvConfig(process.cwd());
const apply=process.argv.includes('--apply');
const migrations=schemaMigrationPlan().filter(m=>['202611130005_veo_calendar_coverage_enrollment.sql'].includes(m.name));assert.equal(migrations.length,1);
const db=new pg.Client({...await migrationConnectionOptions(assertProjectCredentials(process.env,VEO_RECOVERY_PROJECT).connectionString),connectionTimeoutMillis:15000,query_timeout:45000});
try{
 await db.connect();await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='30s'");
 const before=(await db.query('SELECT (SELECT count(*) FROM veo_payments) payments,(SELECT count(*) FROM veo_orders) orders,(SELECT count(*) FROM veo_deal_reviews) reviews')).rows[0];
 for(const m of migrations){
  const existing=(await db.query('SELECT * FROM app_private.veobot_project_migrations WHERE filename=$1',[m.name])).rows[0];
  if(existing){assert(migrationFingerprintMatches(existing,m,VEO_RECOVERY_PROJECT));continue;}
  await db.query(m.sql);await db.query('INSERT INTO app_private.veobot_project_migrations(filename,sha256,project_ref) VALUES($1,$2,$3)',[m.name,m.sha256,VEO_RECOVERY_PROJECT]);
 }
 const after=(await db.query('SELECT (SELECT count(*) FROM veo_payments) payments,(SELECT count(*) FROM veo_orders) orders,(SELECT count(*) FROM veo_deal_reviews) reviews')).rows[0];
 assert.deepEqual(after,before);assert.equal((await db.query("SELECT has_function_privilege('authenticated','veo_calendar_enroll_message_coverage()','EXECUTE') exposed")).rows[0].exposed,false);
 await db.query(apply?'COMMIT':'ROLLBACK');console.log(JSON.stringify({applied:apply,passed:true,migrations:migrations.map(m=>m.name),financialRecordsPreserved:true}));
}catch(e){await db.query('ROLLBACK').catch(()=>{});console.error(e.message);process.exitCode=1;}finally{await db.end();}
