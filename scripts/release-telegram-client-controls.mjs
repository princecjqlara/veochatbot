// Install only the reviewed client-control function patch. No messages or
// assignment actions are invoked by this release or its rollback preflight.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
import { assertProjectCredentials, assertSchemaDestination, schemaMigrationPlan, migrationFingerprintMatches } from './lib/database-migration-safety.mjs';
import { migrationConnectionOptions } from './lib/migration-retry.mjs';
const apply = process.argv.includes('--apply');
assert(apply !== process.argv.includes('--preflight'), 'Choose --preflight or --apply');
const project = assertSchemaDestination(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0]);
const endpoint = assertProjectCredentials(process.env, project);
const migrationIndex = process.argv.indexOf('--migration');
const name = migrationIndex < 0 ? '202611150001_veo_telegram_client_controls.sql' : process.argv[migrationIndex + 1];
assert(['202611150001_veo_telegram_client_controls.sql', '202611150002_veo_telegram_command_controls.sql'].includes(name), 'Choose a reviewed Telegram control migration');
const migration = schemaMigrationPlan().find(m => m.name === name);
assert(migration);
const db = new pg.Client({ ...await migrationConnectionOptions(endpoint.connectionString), connectionTimeoutMillis: 10000, query_timeout: 30000 });
db.on('error', () => {});
const report = { at: new Date().toISOString(), mode: apply ? 'apply' : 'preflight', project, migration: migration.name, applied: false, messagesSent: 0 };
const inventory = async () => (await db.query(`SELECT
 (SELECT count(*)::int FROM veo_client_claims) claims,
 (SELECT count(*)::int FROM veo_client_offers) offers,
 (SELECT count(*)::int FROM veo_telegram_intake_tokens) tokens,
 (SELECT count(*)::int FROM veo_orders) orders,
 (SELECT count(*)::int FROM veo_payments) payments,
 (SELECT count(*)::int FROM user_pages) page_grants,
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM (SELECT id,launch_at FROM veo_tenants) t) cutoffs,
 (SELECT jsonb_agg(to_jsonb(u) ORDER BY u.id) FROM (SELECT id,is_active FROM users) u) accounts`)).rows[0];
try {
 await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
 await db.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='20s'");
 assert((await db.query("SELECT pg_try_advisory_xact_lock(hashtext('veobot_project_schema_install')) locked")).rows[0].locked);
 const before = await inventory();
 const installed = (await db.query('SELECT filename,sha256,project_ref FROM app_private.veobot_project_migrations WHERE filename=$1', [migration.name])).rows[0];
 if (installed) assert(migrationFingerprintMatches(installed, migration, project), 'Installed migration differs');
 else {
  await db.query(migration.sql);
  await db.query('INSERT INTO app_private.veobot_project_migrations(filename,sha256,project_ref) VALUES($1,$2,$3)', [migration.name, migration.sha256, project]);
 }
 assert.deepEqual(await inventory(), before, 'Existing assignments, sales, grants and accounts must be preserved');
 assert.equal((await db.query("SELECT has_function_privilege('anon','veo_telegram_intake(uuid,bigint,bigint,text,jsonb)','EXECUTE') OR has_function_privilege('authenticated','veo_telegram_intake(uuid,bigint,bigint,text,jsonb)','EXECUTE') exposed")).rows[0].exposed, false);
 await db.query(apply ? 'COMMIT' : 'ROLLBACK');
 Object.assign(report, { applied: apply && !installed, existingDataPreserved: true, privateFunctionVerified: true, passed: true });
} catch (error) {
 await db.query('ROLLBACK').catch(() => {});report.passed = false;report.error = error.message;process.exitCode = 1;
} finally {
 await db.end();fs.writeFileSync('.vercel/telegram-client-controls-' + report.mode + '.json', JSON.stringify(report, null, 2));console.log(JSON.stringify(report));
}
