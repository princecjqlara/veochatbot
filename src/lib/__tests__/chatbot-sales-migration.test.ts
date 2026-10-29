import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const page = '10000000-0000-4000-8000-000000000001';
const contact = '20000000-0000-4000-8000-000000000002';
let db: PGlite;
async function update(patch: Record<string, string>, base: Record<string, string>, event: string, source = 'chat', time = '2026-10-30T01:00:00Z', progress = {}) {
    const result = await db.query<{ result: any }>('SELECT public.merge_chatbot_sales_details($1,$2,$3,$4,$5,$6,$7,$8) AS result', [page, contact, patch, base, source, event, time, progress]);
    return result.rows[0].result;
}
beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
        CREATE TABLE contacts (id uuid PRIMARY KEY, page_id uuid NOT NULL);
        CREATE TABLE chatbot_configs (page_id uuid PRIMARY KEY);
        CREATE TABLE chatbot_follow_up_jobs (purpose text);
        CREATE TABLE chatbot_contact_states (page_id uuid, contact_id uuid, collected_details jsonb NOT NULL DEFAULT '{}',
            status text DEFAULT 'active', stop_reason text, pause_kind text, automation_epoch integer DEFAULT 0, UNIQUE(page_id,contact_id));
        INSERT INTO contacts VALUES ('${contact}','${page}'); INSERT INTO chatbot_configs VALUES ('${page}');`);
    const sql = readFileSync('supabase/migrations/202610300002_chatbot_sales_assistant.sql', 'utf8');
    await db.exec(sql); await db.exec(sql);
}, 60000);
afterAll(async () => { await db?.close(); });

describe('real PostgreSQL sales update function', () => {
    it('migration is repeatable and pricing defaults OFF', async () => {
        expect((await db.query<{ sales_assistant_settings: unknown }>('SELECT sales_assistant_settings FROM chatbot_configs')).rows[0].sales_assistant_settings).toEqual({});
    });
    it('merges simultaneous disjoint form/chat edits into one existing record', async () => {
        await Promise.all([update({ 'Business Name': 'Tea House' }, {}, 'one'), update({ 'Product or Service': 'Milk Tea' }, {}, 'two', 'form')]);
        const rows = await db.query<{ collected_details: unknown }>('SELECT collected_details FROM chatbot_contact_states');
        expect(rows.rows).toHaveLength(1); expect(rows.rows[0].collected_details).toEqual({ 'Business Name': 'Tea House', 'Product or Service': 'Milk Tea' });
    });
    it('rejects conflicting stale values while preserving explicit corrections', async () => {
        const base = { 'Business Name': 'Tea House' };
        await update({ 'Business Name': 'New Tea House' }, base, 'correct', 'form', '2026-10-30T02:00:00Z');
        const stale = await update({ 'Business Name': 'Old Guess' }, base, 'stale', 'chat', '2026-10-30T01:10:00Z');
        expect(stale.conflicts).toEqual(['Business Name']); expect(stale.state.collected_details['Business Name']).toBe('New Tea House');
    });
    it('deduplicates events and never erases answers with blank submissions', async () => {
        await update({ 'Preferred Style': 'Realistic' }, {}, 'repeat');
        const result = await update({ 'Preferred Style': 'Animated' }, {}, 'repeat');
        expect(result.duplicate).toBe(true); expect(result.state.collected_details['Preferred Style']).toBe('Realistic');
        const blank = await update({ 'Preferred Style': '' }, { 'Preferred Style': 'Realistic' }, 'blank');
        expect(blank.state.collected_details['Preferred Style']).toBe('Realistic');
    });
    it('records provenance and never changes human ownership, stop reason or automation epoch', async () => {
        await db.exec("UPDATE chatbot_contact_states SET status='stopped',stop_reason='manual',pause_kind='human_takeover',automation_epoch=9");
        const result = await update({ 'Goal ng video': 'Increase orders' }, {}, 'while-human', 'form', '2026-10-30T03:00:00Z', { stage: 'offer_presentation' });
        expect(result.state).toMatchObject({ status: 'stopped', stop_reason: 'manual', pause_kind: 'human_takeover', automation_epoch: 9 });
        expect(result.state.sales_progress.field_sources['Goal ng video']).toMatchObject({ confirmed: true, source: 'form' });
    });
    it('unions delivery receipts without duplicating samples or freebies', async () => {
        await update({}, {}, 'delivery-one', 'delivery', '2026-10-30T04:00:00Z', { samples_sent: ['sample-one'], freebies_presented: ['poster'] });
        const result = await update({}, {}, 'delivery-two', 'delivery', '2026-10-30T04:01:00Z', { samples_sent: ['sample-one', 'sample-two'], freebies_presented: ['poster'] });
        expect(result.state.sales_progress.samples_sent.sort()).toEqual(['sample-one', 'sample-two']);
        expect(result.state.sales_progress.freebies_presented).toEqual(['poster']);
    });
    it('denies public RPC access and cross-page contact updates', async () => {
        await expect(db.query('SELECT public.merge_chatbot_sales_details($1,$2,$3,$4,$5,$6,$7,$8)', ['30000000-0000-4000-8000-000000000003', contact, {}, {}, 'form', 'wrong-page', '2026-10-30T04:00:00Z', {}])).rejects.toThrow('Contact not found');
        const result = await db.query<{ allowed: boolean }>("SELECT has_function_privilege('anon','public.merge_chatbot_sales_details(uuid,uuid,jsonb,jsonb,text,text,timestamptz,jsonb)','EXECUTE') AS allowed");
        expect(result.rows[0].allowed).toBe(false);
    });
    it('enforces follow-up limits across workers, permits retries, and never resumes human ownership', async () => {
        const reserve = async (job: string) => (await db.query<{ allowed: boolean }>('SELECT reserve_chatbot_sales_follow_up($1,$2,$3,$4,$5) AS allowed',
            [page, contact, '2026-10-30T00:00:00Z', job, 1])).rows[0].allowed;
        const jobOne = '30000000-0000-4000-8000-000000000003', jobTwo = '40000000-0000-4000-8000-000000000004';
        expect(await reserve(jobOne)).toBe(false);
        await db.exec("UPDATE chatbot_contact_states SET status='active',stop_reason=NULL,pause_kind=NULL");
        const results = await Promise.all([reserve(jobOne), reserve(jobTwo)]);
        expect(results.filter(Boolean)).toHaveLength(1); expect(await reserve(jobOne)).toBe(true);
        expect(await reserve(jobTwo)).toBe(false);
    });
});
