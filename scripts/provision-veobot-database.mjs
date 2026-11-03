// Install the complete schema in the explicitly named destination only.
// No source database writes, model calls, customer messages or deployment.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { VEO_TARGET_PROJECT, assertProjectCredentials, schemaMigrationPlan, migrationTrackingSql, preserveEmptyLegacyTables, digest } from './lib/database-migration-safety.mjs';
import { migrationConnectionOptions } from './lib/migration-retry.mjs';
import { randomUUID } from 'node:crypto';
const mode = process.argv.includes('--apply') ? 'apply' : process.argv.includes('--preflight') ? 'preflight' : process.argv.includes('--plan') ? 'plan' : null;
if (!mode || ['--apply', '--preflight', '--plan'].filter(arg => process.argv.includes(arg)).length !== 1) throw Error('Choose --plan, --preflight or --apply');
const requested = process.argv.find(arg => arg.startsWith('--target-project='))?.slice(17);
if (requested !== VEO_TARGET_PROJECT) throw Error('Schema installation requires the explicit intended VeoBot project');
const dir = path.resolve('.vercel/database-migration'); fs.mkdirSync(dir, { recursive: true });
const plan = schemaMigrationPlan();
const report = { run_id: process.argv.find(arg => arg.startsWith('--run-id='))?.slice(9) || randomUUID(), started_at: new Date().toISOString(), target_project: requested, mode, applied: false,
 plan: plan.map(({ name, sha256 }) => ({ name, sha256 })), migrations_applied: [], migrations_skipped: [], source_database_writes: 0, customer_messages_sent: 0, openrouter_calls: 0, production_configuration_changed: false };
const flush = () => { const file = path.join(dir, 'schema-' + mode + '.json'), temporary = file + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(report, null, 2)); fs.renameSync(temporary, file); };
let db;
try {
 const manifest = JSON.stringify(report.plan); report.manifest_sha256 = digest(manifest);
 if (mode === 'plan') {
  const sql = 'BEGIN;\n' + migrationTrackingSql + ';\n' + plan.map(item => '-- ' + item.name + '\n' + item.sql).join('\n') + '\nCOMMIT;\n';
  fs.writeFileSync(path.join(dir, 'schema-review.sql'), sql); report.sql_sha256 = digest(sql); report.passed = true;
 } else {
  const endpoint = assertProjectCredentials(process.env, requested);
  db = new pg.Client({ ...await migrationConnectionOptions(endpoint.connectionString), connectionTimeoutMillis: 8000, query_timeout: 120000 }); db.on('error', () => {});
  await db.connect(); await db.query('BEGIN'); await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='90s'");
  if (!(await db.query("SELECT pg_try_advisory_xact_lock(hashtext('veobot_project_schema_install')) AS locked")).rows[0].locked) throw Error('Another schema installer holds the destination lock');
  report.legacy = await preserveEmptyLegacyTables(db);
  await db.query(migrationTrackingSql);
  const recorded = new Map((await db.query('SELECT filename,sha256,project_ref FROM app_private.veobot_project_migrations')).rows.map(row => [row.filename, row]));
  for (const item of plan) {
   const existing = recorded.get(item.name);
   if (existing) { if (existing.sha256 !== item.sha256 || existing.project_ref !== requested) throw Error('Applied migration fingerprint changed: ' + item.name); report.migrations_skipped.push(item.name); continue; }
   report.current_migration = item.name; flush(); await db.query(item.sql);
   await db.query('INSERT INTO app_private.veobot_project_migrations(filename,sha256,project_ref) VALUES($1,$2,$3)', [item.name, item.sha256, requested]);
   report.migrations_applied.push(item.name);
  }
  const required = ['pages', 'users', 'user_pages', 'contacts', 'tags', 'contact_tags', 'ad_contact_sources', 'ad_daily_spend', 'contact_profile_snapshots', 'contact_verified_payments'];
  const tables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename=ANY($1::text[])", [required])).rows.map(row => row.tablename);
  if (required.some(name => !tables.includes(name))) throw Error('Destination schema is incomplete');
  report.required_tables_verified = tables.length;
  await db.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK'); report.applied = mode === 'apply'; report.passed = true;
 }
 report.completed_at = new Date().toISOString();
} catch (error) { if (db) await db.query('ROLLBACK').catch(() => {}); report.passed = false; report.error = error.message.replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted]'); report.code = error.code || null; process.exitCode = 1; }
finally { if (db) await Promise.race([db.end().catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]); flush(); console.log(JSON.stringify({ ...report, plan: report.plan.length }, null, 2)); }
