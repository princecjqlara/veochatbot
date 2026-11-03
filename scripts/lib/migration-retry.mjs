import dns from 'node:dns/promises';
import pg from 'pg';
import { assertProjectCredentials, digest } from './database-migration-safety.mjs';

export function migrationRetryDelay(error, failures) {
 const standard = Math.min(300000, 30000 * 2 ** Math.min(Math.max(0, failures - 1), 4));
 if (/ECIRCUITBREAKER|circuit breaker/i.test(error?.message || '')) return Math.max(150000, standard);
 if (['28P01', '28000', 'ENETUNREACH', 'PROJECT_CONFIG'].includes(error?.code)) return 300000;
 return standard;
}
export function migrationProcessOwnsLock(metadata, lockTime) {
 return metadata?.expected === true && Number.isFinite(Date.parse(metadata.created_at)) && Date.parse(metadata.created_at) <= lockTime;
}
export function migrationCheckpointMatches(receipt, { runId, project, mode, manifestHash, startedAt }) {
 return receipt?.passed === true && receipt.run_id === runId && receipt.target_project === project && receipt.mode === mode &&
  receipt.applied === (mode === 'apply') && receipt.manifest_sha256 === manifestHash &&
  Number.isFinite(Date.parse(receipt.completed_at)) && Date.parse(receipt.started_at) >= startedAt && Date.parse(receipt.completed_at) >= Date.parse(receipt.started_at);
}
export function migrationInputsHash(sourceBytes, targetBytes) {
 return digest(Buffer.concat([Buffer.from(sourceBytes), Buffer.from('\n---destination---\n'), Buffer.from(targetBytes)]));
}
export function installedMigrationPlanMatches(rows, plan, expectedProject) {
 return rows.length === plan.length && plan.every(item => rows.some(row => row.filename === item.name && row.sha256 === item.sha256 && row.project_ref === expectedProject));
}
export async function migrationSchemaIsInstalled(env, project, plan) {
 const endpoint = assertProjectCredentials(env, project), db = new pg.Client({ ...await migrationConnectionOptions(endpoint.connectionString), connectionTimeoutMillis: 6000, query_timeout: 6000 }); db.on('error', () => {});
 try {
  await db.connect(); await db.query('BEGIN READ ONLY');
  const exists = (await db.query("SELECT to_regclass('app_private.veobot_project_migrations') IS NOT NULL AS found")).rows[0].found;
  const rows = exists ? (await db.query('SELECT filename,sha256,project_ref FROM app_private.veobot_project_migrations')).rows : [];
  await db.query('ROLLBACK'); return exists && installedMigrationPlanMatches(rows, plan, project);
 } finally { await Promise.race([db.end().catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]); }
}
/** @param {string} connectionString
 * @param {{resolve4:(host:string)=>Promise<string[]>,resolve6:(host:string)=>Promise<string[]>}} [resolver] */
export async function migrationConnectionOptions(connectionString, resolver = dns) {
 const url = new URL(connectionString);
 const ssl = { rejectUnauthorized: false, servername: url.hostname };
 if (!/^db\.[a-z]{20}\.supabase\.co$/.test(url.hostname)) return { connectionString, ssl };
 let hosts = await resolver.resolve4(url.hostname).catch(error => {
  if (!['ENODATA', 'ENOTFOUND'].includes(error.code)) throw error;
  return [];
 });
 if (!hosts.length) hosts = await resolver.resolve6(url.hostname);
 if (!hosts.length) throw Object.assign(Error('The direct database has no reachable DNS route'), { code: 'ENOTFOUND' });
 return { host: hosts[0], port: Number(url.port || 5432), database: decodeURIComponent(url.pathname.slice(1) || 'postgres'),
  user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), ssl };
}
/** @param {Record<string,string>} env @param {string} expected
 * @param {(options:any)=>{on:Function,connect:()=>Promise<any>,query:Function,end:()=>Promise<any>}} [createClient]
 * @param {number} [connectionWaitMs] */
export async function probeMigrationDatabase(env, expected, createClient = options => new pg.Client(options), connectionWaitMs = 6000) {
 if (!Number.isSafeInteger(connectionWaitMs) || connectionWaitMs < 1000 || connectionWaitMs > 45000) throw Error('Invalid migration connection wait');
 const endpoint = assertProjectCredentials(env, expected), started = Date.now();
 const db = createClient({ ...await migrationConnectionOptions(endpoint.connectionString), connectionTimeoutMillis: connectionWaitMs, query_timeout: 6000, statement_timeout: 6000 });
 db.on('error', () => {});
 try {
  await db.connect(); await db.query('BEGIN READ ONLY'); await db.query('SELECT 1'); await db.query('ROLLBACK');
  return { project: expected, ok: true, elapsed_ms: Date.now() - started };
 } finally { await Promise.race([db.end().catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]); }
}

/** A retry may prepare the target, but must never turn connectivity into proof
 * that a backup, import, or live cutover completed. */
export function migrationStageState(source, target, schemaReady) {
 if (!source?.ok && !target?.ok) return 'waiting_for_source_and_destination';
 if (!target?.ok) return target?.code === 'ENETUNREACH' ? 'destination_requires_ipv4_pooler' : 'waiting_for_destination';
 if (!schemaReady) return 'preparing_destination_schema';
 if (!source?.ok) return 'destination_ready_waiting_for_source';
 return 'database_access_restored_export_pending';
}
