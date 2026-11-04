import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { assertProjectCredentials, LEGACY_SOURCE_PROJECT, VEO_TARGET_PROJECT, preserveEmptyLegacyTables, schemaMigrationPlan, sqlIdentifier } from '../../../scripts/lib/database-migration-safety.mjs';

const credential = (ref: string, role: string) => 'header.' + Buffer.from(JSON.stringify({ ref, role })).toString('base64url') + '.signature';
const targetEnv = () => ({ NEXT_PUBLIC_SUPABASE_URL: 'https://' + VEO_TARGET_PROJECT + '.supabase.co',
 NEXT_PUBLIC_SUPABASE_ANON_KEY: credential(VEO_TARGET_PROJECT, 'anon'), SUPABASE_SERVICE_ROLE_KEY: credential(VEO_TARGET_PROJECT, 'service_role'),
 DATABASE_URL: 'postgresql://postgres:example@db.' + VEO_TARGET_PROJECT + '.supabase.co:5432/postgres' });
const adapter = (db: PGlite) => ({ query: async (sql: string, args?: any[]) => args ? db.query(sql, args) : (await db.exec(sql)).at(-1) || { rows: [] } });
describe('VeoBot database migration safeguards', () => {
 it('accepts only consistent project credentials and refuses an inherited Tokko Dev route or key', () => {
  expect(assertProjectCredentials(targetEnv(), VEO_TARGET_PROJECT).project).toBe(VEO_TARGET_PROJECT);
  for (const changed of [
   { DATABASE_POOLER_URL_5432: 'postgresql://postgres.' + LEGACY_SOURCE_PROJECT + ':example@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres' },
   { SUPABASE_SERVICE_ROLE_KEY: credential(LEGACY_SOURCE_PROJECT, 'service_role') },
   { NEXT_PUBLIC_SUPABASE_ANON_KEY: credential(VEO_TARGET_PROJECT, 'service_role') },
   { NEXT_PUBLIC_SUPABASE_URL: 'https://' + LEGACY_SOURCE_PROJECT + '.supabase.co' }
  ]) expect(() => assertProjectCredentials({ ...targetEnv(), ...changed }, VEO_TARGET_PROJECT)).toThrow(/differs/);
  expect(() => sqlIdentifier('contacts; DROP TABLE pages')).toThrow('Unsafe');
 });
 it('preserves the empty legacy schema in the installer transaction and rolls it back during preflight', async () => {
  const db = new PGlite();
  try {
   await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE TABLE pages(id text PRIMARY KEY,name text);CREATE TABLE messages(id text PRIMARY KEY,page_id text REFERENCES pages(id));');
   await db.exec('BEGIN');
   expect(await preserveEmptyLegacyTables(adapter(db))).toEqual({ preserved: ['messages', 'pages'], schema: 'veobot_legacy' });
   expect((await db.query<any>("SELECT to_regclass('public.pages') AS original,to_regclass('veobot_legacy.pages') AS saved")).rows[0]).toMatchObject({ original: null, saved: 'veobot_legacy.pages' });
   await db.exec('ROLLBACK');
   expect((await db.query<any>("SELECT to_regclass('public.pages') AS original,to_regclass('veobot_legacy.pages') AS saved")).rows[0]).toMatchObject({ original: 'pages', saved: null });
   await db.exec("INSERT INTO pages VALUES('old','Existing record');"); await db.exec('BEGIN');
   await expect(preserveEmptyLegacyTables(adapter(db))).rejects.toThrow('not empty'); await db.exec('ROLLBACK');
   expect((await db.query('SELECT * FROM pages')).rows).toEqual([{ id: 'old', name: 'Existing record' }]);
  } finally { await db.close(); }
 });
 it('installs every maintained migration with the real vector extension and checks profile/calendar privacy', async () => {
  const db = await PGlite.create({ extensions: { 'uuid-ossp': uuid_ossp, pg_trgm, vector } });
  try {
   // Supabase supplies pg_cron. Only the scheduler is stubbed in WASM tests;
   // production executes the original extension declaration in its preflight.
   await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA extensions;CREATE SCHEMA cron;
    CREATE TABLE cron.job(jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,jobname text);CREATE TABLE cron.job_run_details(end_time timestamptz);
    CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS 'INSERT INTO cron.job(jobname) VALUES($1) RETURNING jobid';
    CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE sql AS 'DELETE FROM cron.job WHERE jobid=$1 RETURNING true';
    CREATE TABLE pages(id text PRIMARY KEY,name text);CREATE TABLE messages(id text PRIMARY KEY,page_id text REFERENCES pages(id));`);
   await db.exec('BEGIN');
   await preserveEmptyLegacyTables(adapter(db));
   const plan = schemaMigrationPlan(); expect(plan).toHaveLength(64);
   for (const migration of plan) await db.exec(migration.sql.replace(/CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;/g, '-- local scheduler stub'));
   const fields = (await db.query<any>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='pages'")).rows.map(row => row.column_name);
   expect(fields).toContain('fb_page_id');
   const required = ['pages', 'contacts', 'user_pages', 'contact_verified_payments', 'ad_daily_spend', 'contact_profile_snapshots'];
   expect((await db.query<any>("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tablename=ANY($1::text[])", [required])).rows[0].n).toBe(required.length);
   expect((await db.query<any>("SELECT has_function_privilege('anon','public.get_ad_calendar_report(uuid[],timestamptz,timestamptz,text)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false);
   expect((await db.query<any>("SELECT has_function_privilege('anon','public.get_contact_finance_records(uuid,uuid)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false);
   expect((await db.query<any>("SELECT has_function_privilege('anon','public.get_automation_page_scope()','EXECUTE') AS allowed")).rows[0].allowed).toBe(false);
   const own='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
   await db.query("INSERT INTO pages(id,fb_page_id,name,access_token,automation_app_id) VALUES($1,'111','Owned','test','veo'),($2,'222','Preserved','test','tokko')",[own,other]);
   await db.exec("INSERT INTO app_private.veobot_runtime_policy VALUES(true,'veo',true)");
   expect((await db.query<any>('SELECT public.get_automation_page_scope() AS ids')).rows[0].ids).toEqual([own]);
   await db.exec(`INSERT INTO chatbot_configs(page_id,enabled) VALUES('${own}',true),('${other}',true);INSERT INTO chatbot_inbound_recovery_pages(page_id,enabled) VALUES('${own}',true),('${other}',true) ON CONFLICT(page_id) DO UPDATE SET enabled=true;`);
   expect((await db.query<any>('SELECT page_id FROM public.claim_chatbot_inbound_recovery_pages(3,now())')).rows.map(r=>r.page_id)).toEqual([own]);
   expect((await db.query<any>('SELECT enabled,lease_until FROM chatbot_inbound_recovery_pages WHERE page_id=$1',[other])).rows[0]).toMatchObject({enabled:true,lease_until:null});
   await db.exec('ROLLBACK');
   expect((await db.query<any>("SELECT to_regclass('public.contacts') AS contacts")).rows[0].contacts).toBeNull();
   expect((await db.query<any>("SELECT to_regclass('public.pages') AS original")).rows[0].original).toBe('pages');
  } finally { await db.close(); }
 }, 60000);
});
