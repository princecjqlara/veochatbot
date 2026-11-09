import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { assertProjectCredentials, assertSchemaDestination, LEGACY_SOURCE_PROJECT, VEO_TARGET_PROJECT, VEO_RECOVERY_PROJECT, preserveEmptyLegacyTables, schemaMigrationPlan, sqlIdentifier, digest, migrationFingerprintMatches } from '../../../scripts/lib/database-migration-safety.mjs';

const credential = (ref: string, role: string) => 'header.' + Buffer.from(JSON.stringify({ ref, role })).toString('base64url') + '.signature';
const targetEnv = () => ({ NEXT_PUBLIC_SUPABASE_URL: 'https://' + VEO_TARGET_PROJECT + '.supabase.co',
 NEXT_PUBLIC_SUPABASE_ANON_KEY: credential(VEO_TARGET_PROJECT, 'anon'), SUPABASE_SERVICE_ROLE_KEY: credential(VEO_TARGET_PROJECT, 'service_role'),
 DATABASE_URL: 'postgresql://postgres:example@db.' + VEO_TARGET_PROJECT + '.supabase.co:5432/postgres' });
const adapter = (db: PGlite) => ({ query: async (sql: string, args?: any[]) => args ? db.query(sql, args) : (await db.exec(sql)).at(-1) || { rows: [] } });
describe('VeoBot database migration safeguards', () => {
 it('accepts newline-only fingerprint differences and rejects SQL changes or another project', () => {
  const item = { sha256: digest('SELECT 1;\n'), compatibleSha256: [digest('SELECT 1;\r\n')] };
  expect(migrationFingerprintMatches({sha256:digest('SELECT 1;\r\n'),project_ref:VEO_RECOVERY_PROJECT},item,VEO_RECOVERY_PROJECT)).toBe(true);
  expect(migrationFingerprintMatches({sha256:digest('SELECT 2;\n'),project_ref:VEO_RECOVERY_PROJECT},item,VEO_RECOVERY_PROJECT)).toBe(false);
  expect(migrationFingerprintMatches({sha256:item.sha256,project_ref:LEGACY_SOURCE_PROJECT},item,VEO_RECOVERY_PROJECT)).toBe(false);
 });
 it('limits schema installation to the original or explicitly approved recovery project', () => {
  expect(assertSchemaDestination(VEO_TARGET_PROJECT)).toBe(VEO_TARGET_PROJECT);
  expect(assertSchemaDestination(VEO_RECOVERY_PROJECT)).toBe(VEO_RECOVERY_PROJECT);
  for (const project of [LEGACY_SOURCE_PROJECT, 'other', undefined]) expect(() => assertSchemaDestination(project)).toThrow('approved');
  const env={ NEXT_PUBLIC_SUPABASE_URL:'https://'+VEO_RECOVERY_PROJECT+'.supabase.co',NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_publishable_test',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_test',
   DATABASE_POOLER_URL_5432:'postgresql://postgres.'+VEO_RECOVERY_PROJECT+':example@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres' };
  expect(assertProjectCredentials(env,VEO_RECOVERY_PROJECT).project).toBe(VEO_RECOVERY_PROJECT);
  expect(()=>assertProjectCredentials({...env,DATABASE_URL:targetEnv().DATABASE_URL},VEO_RECOVERY_PROJECT)).toThrow('differs');
 });
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
   const plan = schemaMigrationPlan();
   for (const item of plan) {
    expect(item.sql).not.toContain('\r');
    expect(item.sha256).toBe(digest(fs.readFileSync('supabase/migrations/'+item.name)));
   }
   expect(plan.length).toBeGreaterThanOrEqual(64);
   expect(plan.some(m => m.sql.includes('CREATE TABLE public.veo_tenants'))).toBe(true);
   for (const migration of plan) await db.exec(migration.sql.replace(/CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;/g, '-- local scheduler stub'));
   const fields = (await db.query<any>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='pages'")).rows.map(row => row.column_name);
   expect(fields).toContain('fb_page_id');
   const required = ['pages', 'contacts', 'user_pages', 'contact_verified_payments', 'ad_daily_spend', 'contact_profile_snapshots', 'veo_accounts', 'veo_orders', 'veo_payments', 'veo_photo_objects'];
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
   const owner='00000000-0000-4000-8000-000000000003',contact='00000000-0000-4000-8000-000000000004',tag='00000000-0000-4000-8000-000000000005';
   await db.query("INSERT INTO users(id,email,name) VALUES($1,'owner@example.test','Owner')",[owner]);
   await db.query('INSERT INTO user_pages(user_id,page_id) VALUES($1,$2)',[owner,own]);
   await db.query("INSERT INTO contacts(id,page_id,psid,name,best_contact_hour) VALUES($1,$2,'person','Retained contact',10)",[contact,own]);
   await db.query("INSERT INTO tags(id,name,owner_type,owner_id,page_id) VALUES($1,'Important','page',$2,$2)",[tag,own]);
   await db.query('INSERT INTO contact_tags(contact_id,tag_id) VALUES($1,$2)',[contact,tag]);
   await db.query("INSERT INTO contact_profile_snapshots(contact_id,page_id,generation,source_cutoff_at,message_count,model,payload) VALUES($1,$2,1,now(),1,'test','{}'),($1,$2,2,now(),2,'test','{}')",[contact,own]);
   await db.query("INSERT INTO contact_verified_payments(request_id,page_id,contact_id,kind,amount_minor,currency,occurred_at,reference,verified_by) VALUES(gen_random_uuid(),$1,$2,'full',10000,'PHP',now(),'verified-test',$3)",[own,contact,owner]);
   await db.query('SELECT veo_launch($1,ARRAY[$2]::uuid[])',[owner,own]);
   expect((await db.query<any>("SELECT count(*)::int AS n FROM veo_archive_records WHERE source_table='contact_profile_snapshots'")).rows[0].n).toBe(0);
   expect((await db.query<any>('SELECT count(*)::int AS n FROM contact_profile_snapshots')).rows[0].n).toBe(2);
   expect((await db.query<any>("SELECT count(*)::int AS n FROM veo_archive_records WHERE source_table='contact_verified_payments'")).rows[0].n).toBe(1);
   expect((await db.query<any>('SELECT count(*)::int AS n FROM contact_verified_payments')).rows[0].n).toBe(1);
   expect((await db.query<any>('SELECT best_contact_hour FROM contacts WHERE id=$1',[contact])).rows[0].best_contact_hour).toBe(10);
   expect((await db.query<any>('SELECT count(*)::int AS n FROM contact_tags WHERE contact_id=$1 AND tag_id=$2',[contact,tag])).rows[0].n).toBe(1);
   const stageBefore=(await db.query<any>('SELECT count(*)::int AS n FROM ad_lead_stage_events')).rows[0].n;
   const jobsBefore=(await db.query<any>('SELECT count(*)::int AS n FROM veo_source_jobs')).rows[0].n;
   const batch=[{psid:'900001',name:'Synced contact'},{psid:'900001',name:'Synced contact'}];
   expect((await db.query<any>('SELECT veo_seed_contact_identities($1,$2,$3::jsonb) AS result',[owner,own,JSON.stringify(batch)])).rows[0].result).toMatchObject({received:2,inserted:1,skipped:1});
   expect((await db.query<any>('SELECT veo_seed_contact_identities($1,$2,$3::jsonb) AS result',[owner,own,JSON.stringify([{psid:'900001',name:'Overwrite'}])])).rows[0].result.inserted).toBe(0);
   expect((await db.query<any>("SELECT name,last_inbound_at,last_interaction_at FROM contacts WHERE psid='900001'")).rows[0]).toEqual({name:'Synced contact',last_inbound_at:null,last_interaction_at:null});
   expect((await db.query<any>('SELECT count(*)::int AS n FROM ad_lead_stage_events')).rows[0].n).toBe(stageBefore);
   expect((await db.query<any>('SELECT count(*)::int AS n FROM veo_source_jobs')).rows[0].n).toBe(jobsBefore);
   const recovered='00000000-0000-4000-8000-000000000006';
   await db.query("INSERT INTO users(id,name,is_active) VALUES($1,'Recovered member',false)",[recovered]);
   await db.query("INSERT INTO veo_accounts(user_id,tenant_id,role,parent_id) SELECT $1,tenant_id,'member',user_id FROM veo_accounts WHERE user_id=$2",[recovered,owner]);
   await db.query('INSERT INTO user_pages(user_id,page_id) VALUES($1,$2)',[recovered,own]);
   const testHash='veo-sha256:$2b$12$'+'a'.repeat(53);
   expect((await db.query<any>('SELECT veo_recover_account_login($1,$2,$3,$4) AS result',[owner,recovered,'MEMBER@example.test',testHash])).rows[0].result).toMatchObject({id:recovered,email:'member@example.test',role:'member'});
   expect((await db.query<any>('SELECT role,parent_id FROM veo_accounts WHERE user_id=$1',[recovered])).rows[0]).toEqual({role:'member',parent_id:owner});
   expect((await db.query<any>('SELECT count(*)::int AS n FROM user_pages WHERE user_id=$1 AND page_id=$2',[recovered,own])).rows[0].n).toBe(1);
   expect((await db.query<any>("SELECT has_function_privilege('anon','veo_recover_account_login(uuid,uuid,text,text)','EXECUTE') AS login,has_function_privilege('anon','veo_seed_contact_identities(uuid,uuid,jsonb)','EXECUTE') AS sync")).rows[0]).toEqual({login:false,sync:false});
   await db.exec('ROLLBACK');
   expect((await db.query<any>("SELECT to_regclass('public.contacts') AS contacts")).rows[0].contacts).toBeNull();
   expect((await db.query<any>("SELECT to_regclass('public.pages') AS original")).rows[0].original).toBe('pages');
  } finally { await db.close(); }
 }, 60000);
});
