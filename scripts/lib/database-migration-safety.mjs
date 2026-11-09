import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const VEO_TARGET_PROJECT = 'vhtbmdizugnxkgocmruq';
export const VEO_RECOVERY_PROJECT = 'mjuluaqrvbnycisnarzi';
export const LEGACY_SOURCE_PROJECT = 'pnhzpeyzpwsmwcuafgpw';
export function assertSchemaDestination(project) {
 if (![VEO_TARGET_PROJECT, VEO_RECOVERY_PROJECT].includes(project)) throw Error('Schema installation requires an explicitly approved VeoBot destination');
 return project;
}
export const sqlIdentifier = name => {
 if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw Error('Unsafe SQL identifier');
 return '"' + name + '"';
};
export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
// Execution already normalizes Windows newlines. Accept either original byte
// representation without rewriting receipts or accepting any SQL change.
export function migrationFingerprintMatches(recorded, item, project) {
 return recorded?.project_ref === project && (recorded.sha256 === item.sha256 || item.compatibleSha256?.includes(recorded.sha256) === true);
}

export function assertProjectCredentials(env, expected) {
 if (!/^[a-z]{20}$/.test(expected)) throw Error('Invalid expected database project');
 const api = new URL(env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL || 'missing:');
 if (api.protocol !== 'https:' || api.hostname !== expected + '.supabase.co') throw Error('Supabase API project differs from the migration target');
 for (const [key, role] of [['SUPABASE_SERVICE_ROLE_KEY', 'service_role'], ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon']]) {
  if (!env[key]) throw Error('Required Supabase credential is absent: ' + key);
  if (env[key].split('.').length === 3) {
   let claim; try { claim = JSON.parse(Buffer.from(env[key].split('.')[1], 'base64url')); } catch { throw Error('Invalid Supabase credential'); }
   if (claim.ref !== expected || claim.role !== role) throw Error('Supabase credential project or role differs from the migration target');
  }
 }
 for (const key of ['DATABASE_URL', 'DATABASE_POOLER_URL_5432', 'DATABASE_POOLER_URL_6543'].filter(key => env[key])) {
  const connection = new URL(env[key]);
  if (!['postgres:', 'postgresql:'].includes(connection.protocol)) throw Error('Invalid database protocol');
  const direct = connection.hostname === 'db.' + expected + '.supabase.co';
  const pooled = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(connection.hostname) && decodeURIComponent(connection.username).endsWith('.' + expected);
  if (!direct && !pooled) throw Error('Database route differs from the migration target: ' + key);
 }
 const connectionString = env.DATABASE_POOLER_URL_5432 || env.DATABASE_URL;
 if (!connectionString) throw Error('A verified PostgreSQL connection is required for schema installation');
 return { project: expected, connectionString };
}

export function schemaMigrationPlan(directory = 'supabase/migrations') {
 const files = fs.readdirSync(directory).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
 if (files[0] !== '001_initial_schema.sql') throw Error('Complete VeoBot baseline is missing');
 return files.map(name => {
  const original = fs.readFileSync(path.join(directory, name), 'utf8');
  // The installer owns the transaction, including preflight rollback.
  // SQL patch migrations compare function bodies with LF literals. Normalize
  // Windows checkouts before execution, while retaining original file hashes
  // so existing installation receipts remain valid.
  const sql = original.replace(/\r\n?/g, '\n').replace(/^[ \t]*(?:BEGIN|COMMIT);[ \t]*$/gm, '');
  if (/\b(?:CREATE|DROP)\s+INDEX\s+CONCURRENTLY\b/i.test(sql)) throw Error('Nontransactional migration needs explicit handling: ' + name);
  const normalized = original.replace(/\r\n?/g, '\n');
  return { name, sha256: digest(original), compatibleSha256: [...new Set([digest(normalized), digest(normalized.replace(/\n/g, '\r\n'))])], sql };
 });
}

export const migrationTrackingSql = `CREATE SCHEMA IF NOT EXISTS app_private;
 REVOKE ALL ON SCHEMA app_private FROM PUBLIC,anon,authenticated;
 CREATE TABLE IF NOT EXISTS app_private.veobot_project_migrations(
  filename text PRIMARY KEY,sha256 text NOT NULL,project_ref text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp());
 REVOKE ALL ON app_private.veobot_project_migrations FROM PUBLIC,anon,authenticated`;

export async function preserveEmptyLegacyTables(db) {
 const columns = (await db.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='pages'")).rows;
 if (!columns.length || columns.some(column => column.column_name === 'fb_page_id')) return { preserved: [] };
 const names = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => row.tablename);
 if (!names.every(name => ['pages', 'messages'].includes(name))) throw Error('Unrecognized destination schema; retain it for review');
 await db.query('LOCK TABLE ' + names.map(name => 'public.' + sqlIdentifier(name)).join(',') + ' IN ACCESS EXCLUSIVE MODE');
 for (const name of names) {
  const count = (await db.query('SELECT count(*)::text AS n FROM public.' + sqlIdentifier(name))).rows[0].n;
  if (count !== '0') throw Error('Destination legacy data is not empty; preserve/export it before proceeding');
 }
 await db.query('CREATE SCHEMA IF NOT EXISTS veobot_legacy; REVOKE ALL ON SCHEMA veobot_legacy FROM PUBLIC,anon,authenticated');
 for (const name of names) await db.query('ALTER TABLE public.' + sqlIdentifier(name) + ' SET SCHEMA veobot_legacy');
 return { preserved: names, schema: 'veobot_legacy' };
}
