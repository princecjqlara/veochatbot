import fs from 'node:fs';
import assert from 'node:assert/strict';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { assertProjectCredentials, schemaMigrationPlan, migrationFingerprintMatches, digest } from './lib/database-migration-safety.mjs';

const mode = process.argv[2];
assert(['preflight', 'apply', 'verify'].includes(mode));
const env = parseEnv(fs.readFileSync('.env.local', 'utf8'));
const target = assertProjectCredentials(env, 'mjuluaqrvbnycisnarzi');
const item = schemaMigrationPlan().find(m => m.name === '202611200002_veo_compact_retention_index.sql');
assert(item);
const oldName = 'veo_event_retention_due', newName = 'veo_event_retention_date_online';
const predicate = "((status = 'done'::text) AND (payload <> '{}'::jsonb))";
const db = new pg.Client({ connectionString: target.connectionString, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000, query_timeout: 70000 });
db.on('error', () => {});
const report = { at: new Date().toISOString(), project: target.project, mode, migration: item.name, business_records_deleted: 0, payloads_changed: 0 };
let schemaLock = false, capacityLock = false;
async function index(name) {
  return (await db.query(`SELECT i.oid::int oid,i.relname name,x.indrelid::int table_oid,t.relfilenode table_filenode,am.amname method,x.indnkeyatts keys,x.indnatts attributes,x.indisvalid valid,x.indisready ready,x.indislive live,x.indisunique unique_key,x.indisprimary primary_key,x.indisreplident replica_identity,pg_relation_size(i.oid)::double precision bytes,pg_get_indexdef(i.oid) definition,pg_get_indexdef(i.oid,1,true) first_key,CASE WHEN x.indnkeyatts>1 THEN pg_get_indexdef(i.oid,2,true) END second_key,pg_get_expr(x.indpred,x.indrelid) predicate,(SELECT count(*)::int FROM pg_constraint c WHERE c.conindid=i.oid) constraints FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid JOIN pg_am am ON am.oid=i.relam WHERE i.oid=to_regclass($1)`, ['public.' + name])).rows[0];
}
function checkIndex(i, keys) {
  assert(i && i.method === 'btree' && i.keys === keys && i.attributes === keys && i.first_key === 'received_at' && (keys === 1 || i.second_key === 'event_key') && i.predicate === predicate && !i.unique_key && !i.primary_key && !i.replica_identity && !i.constraints, 'Unexpected index definition; retain it for review');
}
async function resources() {
  const h = (await db.query('SELECT veo_storage_status() v')).rows[0].v;
  report.last_health = h;
  assert(h.metrics_fresh && h.resource_metrics_fresh && !h.resource_pressure && !h.optional_work_paused && h.disk_available_bytes > 1024 ** 3, 'Database capacity requires deferring index maintenance');
  const r = await fetch(env.NEXT_PUBLIC_SUPABASE_URL + '/customer/v1/privileged/metrics', { headers: { Authorization: 'Basic ' + Buffer.from('service_role:' + env.SUPABASE_SERVICE_ROLE_KEY).toString('base64') }, signal: AbortSignal.timeout(10000), cache: 'no-store' });
  assert(r.ok, 'Fresh host metrics are unavailable');
  const metrics = {};
  for (const line of (await r.text()).split('\n')) {
    const m = /^(node_time_seconds|node_load1|node_memory_MemAvailable_bytes|node_memory_SwapFree_bytes)(?:\{[^}]*\})?\s+([\d.eE+-]+)/.exec(line);
    if (m) metrics[m[1]] = Number(m[2]);
  }
  report.live_metrics = metrics;
  const age = Date.now() / 1000 - metrics.node_time_seconds;
  assert(age >= -10 && age <= 90 && metrics.node_load1 < h.resources.cpu_count && metrics.node_memory_MemAvailable_bytes > 80 * 1024 ** 2 && metrics.node_memory_SwapFree_bytes > 128 * 1024 ** 2, 'Current host resources require deferring index maintenance');
}
async function invariants() {
  const rows = (await db.query("SELECT oid::regprocedure::text signature,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid IN('veo_storage_maintenance()'::regprocedure,'veo_storage_status()'::regprocedure) ORDER BY oid")).rows;
  const constraints = (await db.query("SELECT pg_get_indexdef(indexrelid) definition FROM pg_index WHERE indexrelid='public.veo_event_inbox_pkey'::regclass")).rows;
  const finance = (await db.query("SELECT (SELECT count(*) FROM veo_orders)::int orders,(SELECT count(*) FROM veo_payments)::int payments,(SELECT count(*) FROM veo_deal_reviews)::int reviews")).rows[0];
  return { functions_sha256: digest(JSON.stringify(rows)), primary_key: constraints, financial_counts: finance };
}
async function locks() {
  if (!schemaLock) schemaLock = (await db.query("SELECT pg_try_advisory_lock(hashtext('veobot_project_schema_install')) ok")).rows[0].ok;
  assert(schemaLock, 'Another schema installation is active');
  for (let attempt = 0; attempt < 4 && !capacityLock; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 1000));
    capacityLock = (await db.query("SELECT pg_try_advisory_lock(hashtextextended('veo-heavy-background-capacity',0)) ok")).rows[0].ok;
  }
  assert(capacityLock, 'Background database capacity is busy');
}
const from = new Date(Date.now() - 2 * 86400000).toISOString(), to = new Date(Date.now() - 86400000).toISOString();
const sampleSql = "SELECT event_key FROM public.veo_event_inbox WHERE status='done' AND payload<>'{}'::jsonb AND received_at>=$1::timestamptz AND received_at<$2::timestamptz ORDER BY received_at,event_key LIMIT 500";
async function sample() {
  const rows = (await db.query(sampleSql, [from, to])).rows;
  const plan = (await db.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + sampleSql, [from, to])).rows[0]['QUERY PLAN'][0];
  return { rows: rows.length, sha256: digest(JSON.stringify(rows)), execution_ms: plan['Execution Time'], plan: plan.Plan };
}
try {
  await db.connect();
  for (const sql of ["SET application_name='veo-compact-retention-release'", "SET statement_timeout='45s'", "SET lock_timeout='3s'", "SET maintenance_work_mem='16MB'", "SET work_mem='2MB'", 'SET max_parallel_maintenance_workers=0', 'SET max_parallel_workers_per_gather=0', 'SET jit=off']) await db.query(sql);
  const installed = (await db.query('SELECT filename,sha256,project_ref FROM app_private.veobot_project_migrations WHERE filename=$1', [item.name])).rows[0];
  if (installed) assert(migrationFingerprintMatches(installed, item, target.project));
  report.before = await index(oldName);
  if (!report.before && mode === 'apply' && !installed) {
    const replacement = await index(newName);
    checkIndex(replacement, 1);
    assert(replacement.valid && replacement.ready && replacement.live && replacement.table_oid === Number((await db.query("SELECT 'public.veo_event_inbox'::regclass::oid::int oid")).rows[0].oid));
    await resources();await locks();
    await db.query('ALTER INDEX public.' + newName + ' RENAME TO ' + oldName);
    report.recovered_interrupted_rename = true;
    report.before = await index(oldName);
  }
  assert(report.before, 'Retention index is missing; inspect the prepared replacement');
  checkIndex(report.before, report.before.keys);
  assert([1, 2].includes(report.before.keys));
  report.invariants_before = await invariants();
  report.sample_before = await sample();
  report.database_bytes_before = Number((await db.query('SELECT pg_database_size(current_database())::text bytes')).rows[0].bytes);
  if (mode === 'apply' && !installed) {
    await resources();
    await locks();
    assert.equal((await db.query('SELECT 1 FROM pg_stat_progress_create_index')).rowCount, 0, 'Another index build is active');
    if (report.before.keys === 2) {
      let replacement = await index(newName);
      if (replacement) { checkIndex(replacement, 1); assert.equal(replacement.table_oid, report.before.table_oid); }
      if (replacement && !replacement.valid) {
        await db.query('DROP INDEX CONCURRENTLY public.' + newName);
        replacement = null;
      }
      if (!replacement) {
        console.log(JSON.stringify({ phase: 'online-build', index: newName }));
        await db.query('CREATE INDEX CONCURRENTLY ' + newName + " ON public.veo_event_inbox(received_at) WHERE status='done' AND payload<>'{}'::jsonb");
      }
      replacement = await index(newName);checkIndex(replacement, 1);assert(replacement.valid && replacement.ready && replacement.live);
      report.replacement = replacement;
      await resources();
      console.log(JSON.stringify({ phase: 'online-swap', before_bytes: report.before.bytes, replacement_bytes: replacement.bytes }));
      await db.query('DROP INDEX CONCURRENTLY public.' + oldName);
      await db.query('ALTER INDEX public.' + newName + ' RENAME TO ' + oldName);
    }
    await db.query('BEGIN');
    await db.query(item.sql);
    await db.query('INSERT INTO app_private.veobot_project_migrations(filename,sha256,project_ref) VALUES($1,$2,$3)', [item.name, item.sha256, target.project]);
    await db.query('COMMIT');
    report.applied = true;
  }
  report.after = await index(oldName);
  checkIndex(report.after, mode === 'preflight' ? report.before.keys : 1);
  assert(report.after.valid && report.after.ready && report.after.live);
  assert.equal(report.after.table_oid, report.before.table_oid);
  assert.equal(report.after.table_filenode, report.before.table_filenode);
  report.invariants_after = await invariants();
  assert.deepEqual(report.invariants_after, report.invariants_before, 'Retention, primary key or financial counts changed during verification');
  report.sample_after = await sample();
  assert.equal(report.sample_after.sha256, report.sample_before.sha256, 'Cleanup sample changed; inspect live activity');
  assert(report.sample_after.execution_ms < 1000, 'Cleanup sample exceeded the maintenance query budget');
  report.database_bytes_after = Number((await db.query('SELECT pg_database_size(current_database())::text bytes')).rows[0].bytes);
  report.index_bytes_reclaimed = report.before.bytes - report.after.bytes;
  report.passed = true;
} catch (error) {
  await db.query('ROLLBACK').catch(() => {});
  report.passed = false;report.error = error.message;report.code = error.code;process.exitCode = 1;
  // The previous valid index remains in use if the online build is interrupted.
  // Remove only this operation's invalid transient copy, never a table/index
  // with another definition or a valid replacement required after a swap.
  try {
    const old = await index(oldName), scratch = await index(newName);
    if (old?.valid && scratch && !scratch.valid) {
      checkIndex(scratch, 1);assert.equal(scratch.table_oid, old.table_oid);
      await db.query('DROP INDEX CONCURRENTLY public.' + newName);
      report.invalid_transient_removed = true;
    }
  } catch (cleanupError) { report.cleanup_error = cleanupError.message; }
} finally {
  if (capacityLock) await db.query("SELECT pg_advisory_unlock(hashtextextended('veo-heavy-background-capacity',0))").catch(() => {});
  if (schemaLock) await db.query("SELECT pg_advisory_unlock(hashtext('veobot_project_schema_install'))").catch(() => {});
  await db.end().catch(() => {});
  fs.mkdirSync('.vercel', { recursive: true });
  fs.writeFileSync('.vercel/compact-retention-' + mode + '.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ mode, passed: report.passed, applied: report.applied, index_bytes_reclaimed: report.index_bytes_reclaimed, database_bytes_after: report.database_bytes_after, before_query_ms: report.sample_before?.execution_ms, after_query_ms: report.sample_after?.execution_ms, error: report.error, code: report.code, cleanup_error: report.cleanup_error }, null, 2));
}
