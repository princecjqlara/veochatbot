import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { publishBacklogProfile } from '../../../scripts/lib/backlog-profile-publication.mjs';
import { analyzeContactBacklog, BACKLOG_ANALYSIS_VERSION } from '../contact-backlog-analysis';

const page = '00000000-0000-4000-8000-000000000001', contact = '00000000-0000-4000-8000-000000000002', actor = '00000000-0000-4000-8000-000000000003';
let db: PGlite;
const adapter = { query: async (sql: string, args?: any[]) => args ? db.query(sql, args) : (await db.exec(sql)).at(-1) || { rows: [] } };
const artifact = () => ({ ...analyzeContactBacklog({ pageId: page, facebookPageId: '100', psid: '200', cutoff: '2026-02-01T00:00:00Z', messages: [
 { id: 'answer', message: 'Purpose: Facebook ads', created_time: '2026-01-01T00:00:00Z', from: { id: '200' } }
]}), engine: BACKLOG_ANALYSIS_VERSION, page_id: page, facebook_page_id: '100', psid: '200', source_sha256: 'a'.repeat(64), source_cutoff_at: '2026-02-01T00:00:00Z' });

describe('prepared backlog profile publication', () => {
 beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA app_private;
   CREATE TABLE pages(id uuid PRIMARY KEY,fb_page_id text); CREATE TABLE users(id uuid PRIMARY KEY,name text);
   CREATE TABLE contacts(id uuid PRIMARY KEY,page_id uuid REFERENCES pages(id),psid text,last_interaction_at timestamptz,last_inbound_at timestamptz,messenger_stage_event_at timestamptz,tags text[],chatbot_enabled boolean,pipeline_stage text,UNIQUE(page_id,psid));
   CREATE TABLE user_pages(page_id uuid,user_id uuid);
   CREATE TABLE messenger_lead_stage_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,page_id uuid,contact_id uuid,applied boolean DEFAULT false,observed_at timestamptz DEFAULT now());
   CREATE TABLE outbound_message_events(page_id uuid,contact_id uuid,sent_at timestamptz);
   CREATE TABLE ad_lead_stage_events(page_id uuid,contact_id uuid,recorded_at timestamptz);
   INSERT INTO pages VALUES('${page}','100'); INSERT INTO users VALUES('${actor}','Staff');`);
  await db.exec(readFileSync('supabase/migrations/202611020004_contact_profiles.sql', 'utf8'));
 });
 afterAll(async () => { await db.close(); });
 beforeEach(async () => {
  await db.exec(`TRUNCATE contacts CASCADE;
   INSERT INTO contacts(id,page_id,psid,tags,chatbot_enabled,pipeline_stage) VALUES('${contact}','${page}','200',ARRAY['keep'],false,'converted');`);
 });
 it('rolls back every preflight write, resolves by Page and PSID, publishes once and preserves finance and controls', async () => {
  expect(await publishBacklogProfile(adapter, artifact(), false)).toMatchObject({ status: 'preflight_passed', generation: 1 });
  expect((await db.query('SELECT * FROM contact_profile_jobs')).rows).toHaveLength(0);
  expect((await db.query('SELECT * FROM contact_profile_snapshots')).rows).toHaveLength(0);
  expect((await db.query<any>("SELECT to_regclass('app_private.contact_backlog_publications') AS journal")).rows[0].journal).toBeNull();
  await db.exec(`INSERT INTO contact_purchases(request_id,page_id,contact_id,description,total_minor,purchased_at,recorded_by)
   VALUES(gen_random_uuid(),'${page}','${contact}','Existing purchase',70000,'2026-01-01','${actor}');
   INSERT INTO contact_verified_payments(request_id,page_id,contact_id,kind,amount_minor,occurred_at,reference,verified_by)
   VALUES(gen_random_uuid(),'${page}','${contact}','deposit',15000,'2026-01-01','REAL-RECEIPT','${actor}');`);
  const before = (await db.query('SELECT * FROM contact_verified_payments')).rows;
  const prepared: any = { ...artifact(), contact_id: '99999999-9999-4999-8999-999999999999' };
  expect(await publishBacklogProfile(adapter, prepared, true)).toMatchObject({ status: 'published', generation: 1 });
  expect(await publishBacklogProfile(adapter, prepared, true)).toMatchObject({ status: 'already_published' });
  expect((await db.query<any>('SELECT * FROM contact_profile_jobs')).rows[0]).toMatchObject({ contact_id: contact, status: 'ready', requested_version: 1, working_version: 1, message_count: 1, analyzed_count: 1, history_complete: true });
  expect((await db.query('SELECT * FROM contact_profile_snapshots')).rows).toHaveLength(1);
  expect((await db.query('SELECT * FROM contact_profile_messages')).rows).toHaveLength(1);
  expect((await db.query('SELECT * FROM app_private.contact_backlog_publications')).rows).toHaveLength(1);
  expect((await db.query('SELECT * FROM contact_verified_payments')).rows).toEqual(before);
  expect((await db.query<any>('SELECT total_minor FROM contact_purchases')).rows[0].total_minor).toBe(70000);
  expect((await db.query<any>('SELECT tags,chatbot_enabled,pipeline_stage FROM contacts')).rows[0]).toMatchObject({ tags: ['keep'], chatbot_enabled: false, pipeline_stage: 'converted' });
  await db.query('SELECT enqueue_contact_profile($1,$2,$3)', [page, contact, 'profile_open']);
  expect((await db.query<any>('SELECT status,requested_version FROM contact_profile_jobs')).rows[0]).toMatchObject({ status: 'ready', requested_version: 1 });
  await db.query('SELECT enqueue_contact_profile($1,$2,$3)', [page, contact, 'stage_change']);
  expect((await db.query<any>('SELECT status,requested_version FROM contact_profile_jobs')).rows[0]).toMatchObject({ status: 'queued', requested_version: 2 });
 }, 30000);
 it('preserves active and newer review requests and newer contact history', async () => {
  await db.exec(`INSERT INTO contact_profile_jobs(contact_id,page_id,status,lease_until,requested_at) VALUES('${contact}','${page}','processing',now()+interval '1 hour','2026-01-01');`);
  expect(await publishBacklogProfile(adapter, artifact(), true)).toMatchObject({ status: 'active_review_retained' });
  await db.exec(`UPDATE contact_profile_jobs SET status='queued',lease_until=NULL,requested_at='2026-03-01';`);
  expect(await publishBacklogProfile(adapter, artifact(), true)).toMatchObject({ status: 'newer_review_request_retained' });
  await db.exec(`UPDATE contact_profile_jobs SET status='ready'; UPDATE contacts SET last_inbound_at='2026-03-01';`);
  expect(await publishBacklogProfile(adapter, artifact(), true)).toMatchObject({ status: 'fresh_history_needed' });
  expect((await db.query('SELECT * FROM contact_profile_snapshots')).rows).toHaveLength(0);
 });
 it('retains existing model reviews and allocates above old partial message generations', async () => {
  await db.exec(`INSERT INTO contact_profile_snapshots VALUES('${contact}','${page}',4,'2026-01-01',0,'openai/gpt-6-luna','{}',now());`);
  expect(await publishBacklogProfile(adapter, artifact(), true)).toMatchObject({ status: 'existing_review_retained' });
  await db.exec(`DELETE FROM contact_profile_snapshots; INSERT INTO contact_profile_messages(contact_id,page_id,generation,message_id,sent_at,sender) VALUES('${contact}','${page}',7,'partial','2026-01-01','customer');`);
  expect(await publishBacklogProfile(adapter, artifact(), true)).toMatchObject({ status: 'published', generation: 8 });
 });
 it('does not attach an unimported contact or a foreign Page history', async () => {
  expect(await publishBacklogProfile(adapter, { ...artifact(), psid: '300' }, true)).toMatchObject({ status: 'contact_not_imported' });
  await expect(publishBacklogProfile(adapter, { ...artifact(), facebook_page_id: '101' }, true)).rejects.toThrow('Page identity');
  expect((await db.query('SELECT * FROM contact_profile_jobs')).rows).toHaveLength(0);
 });
});
