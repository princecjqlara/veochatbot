import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const page = '00000000-0000-4000-8000-000000000001', contact = '00000000-0000-4000-8000-000000000002', actor = '00000000-0000-4000-8000-000000000003';
const foreign = '00000000-0000-4000-8000-000000000004';
const request = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('contact profile persistence and verified finance', () => {
    it('imports historical stage evidence without an AI backlog and resumes normal queueing after the repair transaction', async () => {
        const db = new PGlite();
        try {
            await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
                CREATE TABLE pages(id uuid PRIMARY KEY); CREATE TABLE users(id uuid PRIMARY KEY,name text);
                CREATE TABLE contacts(id uuid PRIMARY KEY,page_id uuid REFERENCES pages(id));
                CREATE TABLE user_pages(page_id uuid,user_id uuid);
                CREATE TABLE messenger_lead_stage_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,page_id uuid,contact_id uuid,applied boolean DEFAULT false,observed_at timestamptz DEFAULT now());
                CREATE TABLE outbound_message_events(page_id uuid,contact_id uuid,sent_at timestamptz);
                CREATE TABLE ad_lead_stage_events(page_id uuid,contact_id uuid,recorded_at timestamptz);
                INSERT INTO pages VALUES('${page}'); INSERT INTO contacts VALUES('${contact}','${page}');`);
            await db.exec(readFileSync('supabase/migrations/202611020004_contact_profiles.sql', 'utf8'));
            await db.exec(readFileSync('supabase/migrations/202611020008_historical_repair_no_ai.sql', 'utf8'));
            await db.exec('BEGIN');
            await db.query("SELECT set_config('app.historical_lead_repair','deterministic_only',true)");
            await db.query('INSERT INTO messenger_lead_stage_events(page_id,contact_id,applied) VALUES($1,$2,true)', [page, contact]);
            await db.exec('COMMIT');
            expect((await db.query('SELECT * FROM contact_profile_jobs')).rows).toHaveLength(0);
            expect((await db.query('SELECT * FROM messenger_lead_stage_events')).rows).toHaveLength(1);
            await db.query('INSERT INTO messenger_lead_stage_events(page_id,contact_id,applied) VALUES($1,$2,true)', [page, contact]);
            expect((await db.query<any>('SELECT status,requested_version FROM contact_profile_jobs')).rows[0]).toMatchObject({ status: 'queued', requested_version: 1 });
        } finally { await db.close(); }
    }, 30000);

    it('isolates contacts, resumes whole-history analysis, preserves stage-triggered refreshes and audits payments', async () => {
        const db = new PGlite();
        try {
            await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
                CREATE TABLE pages(id uuid PRIMARY KEY); CREATE TABLE users(id uuid PRIMARY KEY,name text);
                CREATE TABLE contacts(id uuid PRIMARY KEY,page_id uuid REFERENCES pages(id));
                CREATE TABLE user_pages(page_id uuid,user_id uuid);
                CREATE TABLE messenger_lead_stage_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,page_id uuid,contact_id uuid,applied boolean DEFAULT false,observed_at timestamptz DEFAULT now());
                CREATE TABLE outbound_message_events(page_id uuid,contact_id uuid,sent_at timestamptz);
                CREATE TABLE ad_lead_stage_events(page_id uuid,contact_id uuid,recorded_at timestamptz);
                INSERT INTO pages VALUES('${page}'),('${foreign}'); INSERT INTO users VALUES('${actor}','Page admin'),('${foreign}','Other user');
                INSERT INTO contacts VALUES('${contact}','${page}'); INSERT INTO user_pages VALUES('${page}','${actor}');`);
            const sql = readFileSync(path.join(process.cwd(), 'supabase/migrations/202611020004_contact_profiles.sql'), 'utf8');
            await db.exec(sql);
            await db.query('SELECT enqueue_contact_profile($1,$2,$3)', [page, contact, 'profile_open']);
            const first: any = (await db.query('SELECT * FROM claim_contact_profile_jobs(1,$1)', [contact])).rows[0];
            expect(first.working_version).toBe(1); expect((await db.query('SELECT * FROM claim_contact_profile_jobs(1,$1)', [contact])).rows).toHaveLength(0);
            expect((await db.query<{ ok: boolean }>('SELECT save_contact_profile_progress($1,$2,$3,$4) AS ok', [contact, foreign, '[]', '{}'])).rows[0].ok).toBe(false);
            const messages = [{ id: 'm1', at: '2026-01-01T00:00:00Z', sender: 'customer', text: 'Purpose: Facebook ads', attachments: 0 }, { id: 'm2', at: '2026-01-01T01:00:00Z', sender: 'page', text: 'We can help.', attachments: 0 }];
            await db.query('SELECT save_contact_profile_progress($1,$2,$3,$4)', [contact, first.claim_token, JSON.stringify(messages), JSON.stringify({ scan_started: true, history_complete: true })]);
            await expect(db.query('SELECT finish_contact_profile_job($1,$2,$3,$4,$5)', [contact, first.claim_token, 'openai/gpt-6-luna', '{}', null])).rejects.toThrow('incomplete');
            await db.query('SELECT save_contact_profile_progress($1,$2,$3,$4)', [contact, first.claim_token, '[]', JSON.stringify({ analyzed_count: 2 })]);
            await db.query('INSERT INTO messenger_lead_stage_events(page_id,contact_id,applied) VALUES($1,$2,true)', [page, contact]);
            await db.query('SELECT finish_contact_profile_job($1,$2,$3,$4,$5)', [contact, first.claim_token, 'openai/gpt-6-luna', JSON.stringify({ summary_points: [] }), null]);
            const pending: any = (await db.query('SELECT * FROM contact_profile_jobs')).rows[0];
            expect(pending.status).toBe('queued'); expect(pending.requested_version).toBe(2);
            expect((await db.query('SELECT * FROM contact_profile_snapshots')).rows).toHaveLength(1);
            const second: any = (await db.query('SELECT * FROM claim_contact_profile_jobs(1,$1)', [contact])).rows[0];
            expect(second.working_version).toBe(2); expect(second.analyzed_count).toBe(0); expect(second.scan_started).toBe(false);
            await db.query('SELECT finish_contact_profile_job($1,$2,$3,$4,$5)', [contact, second.claim_token, 'model', null, 'Temporary source error']);
            expect((await db.query<any>('SELECT attempt_count FROM contact_profile_jobs')).rows[0].attempt_count).toBe(1);
            await db.query('SELECT enqueue_contact_profile($1,$2,$3)', [page, contact, 'profile_open']);
            expect((await db.query<any>('SELECT attempt_count,next_attempt_at>now() AS delayed FROM contact_profile_jobs')).rows[0]).toMatchObject({ attempt_count: 1, delayed: true });

            const purchase: any = (await db.query('SELECT record_contact_purchase($1,$2,$3,$4,$5,$6,$7,$8,$9) AS record',
                [page, contact, actor, request(1), 'Commercial video', 70000, 'PHP', '2026-01-01T01:00:00Z', 'INV-1'])).rows[0];
            const purchaseId = purchase.record.id;
            const paymentArgs = [page, contact, actor, request(2), purchaseId, 'deposit', 15000, 'PHP', '2026-01-01T02:00:00Z', 'GCASH-001', 'm1', 'Checked against payment statement'];
            const paymentSql = 'SELECT record_contact_verified_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS record';
            const paid: any = (await db.query<{ record: any }>(paymentSql, paymentArgs)).rows[0].record;
            expect(paid.evidence_quote).toBe('Purpose: Facebook ads');
            await db.query(paymentSql, paymentArgs);
            expect((await db.query('SELECT * FROM contact_verified_payments')).rows).toHaveLength(1);
            await expect(db.query(paymentSql, paymentArgs.map((value, index) => index === 3 ? request(3) : value))).rejects.toThrow('duplicate key');
            await expect(db.query(paymentSql, paymentArgs.map((value, index) => index === 2 ? foreign : index === 3 ? request(4) : value))).rejects.toThrow('membership');
            await expect(db.query(paymentSql, paymentArgs.map((value, index) => index === 7 ? 'USD' : index === 3 ? request(5) : value))).rejects.toThrow('currency');
            const records: any = (await db.query<{ records: any }>('SELECT get_contact_finance_records($1,$2) AS records', [page, contact])).rows[0].records;
            expect(records.purchases).toHaveLength(1); expect(records.payments[0].verified_by_name).toBe('Page admin');
            expect((await db.query<any>('SELECT get_contact_finance_records($1,$2) AS records', [foreign, contact])).rows[0].records.payments).toHaveLength(0);
            await expect(db.query('SELECT void_contact_verified_payment($1,$2,$3,$4,$5)', [page, contact, paid.id, foreign, 'Wrong page'])).rejects.toThrow('Membership');
            await db.query('SELECT void_contact_verified_payment($1,$2,$3,$4,$5)', [page, contact, paid.id, actor, 'Entered the wrong amount']);
            expect((await db.query<any>('SELECT voided_at,void_reason FROM contact_verified_payments')).rows[0].void_reason).toBe('Entered the wrong amount');
            expect((await db.query('SELECT * FROM contact_verified_payments')).rows).toHaveLength(1);
            expect((await db.query<{ allowed: boolean }>("SELECT has_function_privilege('anon','public.get_contact_finance_records(uuid,uuid)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false);
            await db.exec(sql);
            expect((await db.query('SELECT * FROM contact_verified_payments')).rows).toHaveLength(1);
        } finally { await db.close(); }
    }, 30000);
});
