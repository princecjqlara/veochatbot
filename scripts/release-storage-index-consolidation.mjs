import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { assertProjectCredentials, schemaMigrationPlan, migrationFingerprintMatches, sqlIdentifier } from './lib/database-migration-safety.mjs';

const mode = process.argv[2];
assert(['preflight', 'apply', 'verify'].includes(mode), 'Choose preflight, apply or verify');
const env = parseEnv(fs.readFileSync('.env.local', 'utf8'));
const target = assertProjectCredentials(env, 'mjuluaqrvbnycisnarzi');
const item = schemaMigrationPlan().find(m => m.name === '202611200001_veo_storage_index_consolidation.sql');
assert(item);
const pairs = [
  ['idx_contacts_conversion_first', 'idx_contacts_calendar_inquiry'],
  ['idx_pages_fb_page_id', 'pages_fb_page_id_key'],
  ['idx_users_email', 'users_email_key'],
];
let guardSql = item.sql;
for (const [old] of pairs) {
  const statement = 'DROP INDEX IF EXISTS public.' + old + ';';
  assert(guardSql.includes(statement));
  guardSql = guardSql.replace(statement, '');
}
assert(!/\bDROP\s+INDEX\b/i.test(guardSql));
const db = new pg.Client({ connectionString: target.connectionString, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000, query_timeout: 30000 });
db.on('error', () => {});
const report = { at: new Date().toISOString(), mode, project: target.project, migration: item.name, removed: [], business_records_deleted: 0 };
let schemaLock = false, capacityLock = false;
const financialTables = ['veo_deal_reviews', 'veo_submissions', 'veo_orders', 'veo_payments', 'veo_closed_deals'];
async function snapshot() {
  const result = {};
  for (const table of financialTables) {
    const rows = (await db.query('SELECT to_jsonb(t)::text row FROM public.' + sqlIdentifier(table) + ' t ORDER BY to_jsonb(t)::text')).rows;
    const hash = crypto.createHash('sha256');
    for (const { row } of rows) hash.update(row).update('\n');
    result[table] = { count: rows.length, sha256: hash.digest('hex') };
  }
  return result;
}
async function indexes() {
  return (await db.query(`SELECT i.relname name,x.indisvalid valid,x.indisready ready,x.indislive live,x.indisunique unique_key,t.relname table_name,t.relfilenode table_filenode,pg_relation_size(i.oid)::double precision bytes,pg_get_indexdef(i.oid) definition FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid WHERE i.relnamespace='public'::regnamespace AND i.relname=ANY($1) ORDER BY i.relname`, [pairs.flat()])).rows;
}
async function resources() {
  const h = (await db.query('SELECT veo_storage_status() v')).rows[0].v;
  report.last_health = h;
  // Removing redundant indexes does no table scan or replacement build. Permit
  // the recovery timer alone, provided fresh host readings below also pass;
  // active pressure, stale monitoring and failed retention still defer it.
  const cooldownOnly = h.resource_pressure_reasons?.length === 1 && h.resource_pressure_reasons[0] === 'recovery_cooldown' && h.status !== 'critical' && h.maintenance_healthy;
  assert(h.metrics_fresh && h.resource_metrics_fresh && ((!h.resource_pressure && !h.optional_work_paused) || cooldownOnly), 'Database capacity requires deferring maintenance');
  assert(h.disk_available_bytes > 1024 ** 3, 'Insufficient free disk space for maintenance');
  const response = await fetch(env.NEXT_PUBLIC_SUPABASE_URL + '/customer/v1/privileged/metrics', { headers: { Authorization: 'Basic ' + Buffer.from('service_role:' + env.SUPABASE_SERVICE_ROLE_KEY).toString('base64') }, signal: AbortSignal.timeout(10000), cache: 'no-store' });
  assert(response.ok, 'Fresh resource metrics are unavailable');
  const metrics = {};
  for (const line of (await response.text()).split('\n')) {
    const m = /^(node_time_seconds|node_load1|node_memory_MemAvailable_bytes|node_memory_SwapFree_bytes)(?:\{[^}]*\})?\s+([\d.eE+-]+)/.exec(line);
    if (m) metrics[m[1]] = Number(m[2]);
  }
  const age = Date.now() / 1000 - metrics.node_time_seconds;
  assert(age >= -10 && age <= 90 && metrics.node_load1 < h.resources.cpu_count && metrics.node_memory_MemAvailable_bytes > 80 * 1024 ** 2 && metrics.node_memory_SwapFree_bytes > 128 * 1024 ** 2, 'Current resource sample requires deferring maintenance');
  return { health: h, metrics, age_seconds: age };
}
try {
  await db.connect();
  for (const sql of ["SET application_name='veo-storage-index-release'", "SET statement_timeout='20s'", "SET lock_timeout='1s'", "SET work_mem='2MB'", 'SET max_parallel_workers_per_gather=0', 'SET jit=off']) await db.query(sql);
  const installed = (await db.query('SELECT filename,sha256,project_ref FROM app_private.veobot_project_migrations WHERE filename=$1', [item.name])).rows[0];
  if (installed) assert(migrationFingerprintMatches(installed, item, target.project), 'Recorded migration differs from the source');
  report.before = await indexes();
  report.financial_before = await snapshot();
  report.database_bytes_before = Number((await db.query('SELECT pg_database_size(current_database())::text bytes')).rows[0].bytes);
  if (mode !== 'verify') {
    await db.query('BEGIN');
    await db.query(guardSql);
    await db.query('ROLLBACK');
    report.coverage_guard_passed = true;
  }
  if (mode === 'apply' && !installed) {
    report.resources_before = await resources();
    schemaLock = (await db.query("SELECT pg_try_advisory_lock(hashtext('veobot_project_schema_install')) locked")).rows[0].locked;
    assert(schemaLock, 'Another schema installation is active');
    for (let attempt = 0; attempt < 4 && !capacityLock; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 1000));
      capacityLock = (await db.query("SELECT pg_try_advisory_lock(hashtextextended('veo-heavy-background-capacity',0)) locked")).rows[0].locked;
    }
    assert(capacityLock, 'Background database capacity is busy');
    for (const [old] of pairs) {
      if (!report.before.some(i => i.name === old)) continue;
      await resources();
      console.log(JSON.stringify({ phase: 'online-index-removal', index: old }));
      // One nontransactional statement, with no blocking fallback or CASCADE.
      await db.query('DROP INDEX CONCURRENTLY IF EXISTS public.' + sqlIdentifier(old));
      report.removed.push(old);
    }
    await db.query('BEGIN');
    await db.query(item.sql);
    await db.query('INSERT INTO app_private.veobot_project_migrations(filename,sha256,project_ref) VALUES($1,$2,$3)', [item.name, item.sha256, target.project]);
    await db.query('COMMIT');
    report.applied = true;
  }
  report.after = await indexes();
  if (mode !== 'preflight') {
    for (const [old, keep] of pairs) {
      assert(!report.after.some(i => i.name === old), 'Redundant index remains: ' + old);
      const before = report.before.find(i => i.name === keep), after = report.after.find(i => i.name === keep);
      assert(after?.valid && after.ready && after.live, 'Retained index is unavailable: ' + keep);
      for (const k of ['definition', 'unique_key', 'table_filenode']) assert.equal(after[k], before[k]);
    }
    assert((await db.query('SELECT 1 FROM app_private.veobot_project_migrations WHERE filename=$1', [item.name])).rowCount, 'Migration receipt is missing');
  }
  report.financial_after = await snapshot();
  assert.deepEqual(report.financial_after, report.financial_before, 'Financial records changed during verification; inspect live activity');
  report.financial_unchanged = true;
  report.database_bytes_after = Number((await db.query('SELECT pg_database_size(current_database())::text bytes')).rows[0].bytes);
  report.index_bytes_reclaimed = report.before.filter(i => report.removed.includes(i.name)).reduce((n, i) => n + i.bytes, 0);
  report.passed = true;
} catch (error) {
  await db.query('ROLLBACK').catch(() => {});
  report.passed = false; report.error = error.message; report.code = error.code; process.exitCode = 1;
} finally {
  if (capacityLock) await db.query("SELECT pg_advisory_unlock(hashtextextended('veo-heavy-background-capacity',0))").catch(() => {});
  if (schemaLock) await db.query("SELECT pg_advisory_unlock(hashtext('veobot_project_schema_install'))").catch(() => {});
  await db.end().catch(() => {});
  fs.mkdirSync('.vercel', { recursive: true });
  fs.writeFileSync('.vercel/storage-index-consolidation-' + mode + '.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, mode, removed: report.removed, applied: report.applied, index_bytes_reclaimed: report.index_bytes_reclaimed, database_bytes_after: report.database_bytes_after, financial_unchanged: report.financial_unchanged, error: report.error, code: report.code }, null, 2));
}
