import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('transactional stage reconciliation and additive smart tags', () => {
    it('orders Meta events, accepts reversals, respects human decisions and retains existing tags', async () => {
        const db = new PGlite();
        try {
            await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
                CREATE TABLE pages(id uuid PRIMARY KEY, messaging_auto_tag_enabled boolean DEFAULT true,
                    messaging_auto_tag_attempted_at timestamptz DEFAULT '2026-01-01');
                CREATE TABLE contacts(id uuid PRIMARY KEY,page_id uuid REFERENCES pages(id),pipeline_stage text DEFAULT 'new',
                    pipeline_stage_source text DEFAULT 'system',pipeline_stage_updated_at timestamptz DEFAULT now());
                CREATE TABLE tags(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text,color text,owner_type text,
                    owner_id uuid,page_id uuid,is_default boolean DEFAULT false,system_key text,UNIQUE(owner_id,system_key));
                CREATE TABLE contact_tags(contact_id uuid REFERENCES contacts(id),tag_id uuid REFERENCES tags(id),UNIQUE(contact_id,tag_id));
                CREATE TABLE chatbot_contact_states(page_id uuid,contact_id uuid,messenger_history_reset_at timestamptz);
                CREATE TABLE ad_lead_stage_events(page_id uuid,contact_id uuid,stage text,source text);
                INSERT INTO pages(id) VALUES('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002');
                INSERT INTO contacts(id,page_id) VALUES('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001');
                INSERT INTO tags(id,name,owner_type,owner_id,page_id,is_default) VALUES('00000000-0000-4000-8000-000000000004','Existing owner tag','page','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',true);
                INSERT INTO contact_tags VALUES('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004');`);
            const migration = readFileSync(path.join(process.cwd(), 'supabase/migrations/202611020002_messenger_stage_history.sql'), 'utf8');
            await db.exec(migration);
            await db.exec(readFileSync(path.join(process.cwd(), 'supabase/migrations/202611020003_stage_history_repair_index.sql'), 'utf8'));
            const pageId = '00000000-0000-4000-8000-000000000001', contactId = '00000000-0000-4000-8000-000000000003';
            const apply = async (id: string, label: string, stage: string, minute: number, targetPage = pageId) =>
                (await db.query<{ result: { applied: boolean; reason?: string } }>(
                    'SELECT apply_messenger_lead_stage($1,$2,$3,$4,$5,$6) AS result',
                    [targetPage, contactId, id, label, stage, `2026-10-31T10:${String(minute).padStart(2, '0')}:00Z`])).rows[0].result;
            const current = async () => (await db.query<any>('SELECT pipeline_stage,messenger_stage_label FROM contacts WHERE id=$1', [contactId])).rows[0];
            expect((await apply('qualified', 'Qualified', 'qualified', 1)).applied).toBe(true);
            expect((await apply('converted', 'Converted', 'converted', 2)).applied).toBe(true);
            expect((await apply('qualified-again', 'Qualified', 'qualified', 3)).applied).toBe(true);
            expect((await apply('negative', 'Not Qualified', 'not_qualified', 4)).applied).toBe(true);
            expect(await current()).toMatchObject({ pipeline_stage: 'not_qualified' });
            expect(await apply('late-order', 'Order Created', 'order_created', 3)).toEqual({ applied: false, reason: 'older_event' });
            expect(await apply('negative', 'Not Qualified', 'not_qualified', 4)).toEqual({ applied: false, reason: 'duplicate' });
            expect((await apply('intake', 'Intake', 'new', 5)).applied).toBe(true);
            expect((await apply('custom', 'Consultation booked', 'engaged', 6)).applied).toBe(true);
            expect(await current()).toEqual({ pipeline_stage: 'engaged', messenger_stage_label: 'Consultation booked' });
            await db.exec(`UPDATE contacts SET pipeline_stage='qualified',pipeline_stage_source='manual',pipeline_stage_updated_at='2026-10-31T10:09:00Z' WHERE id='${contactId}'`);
            expect((await apply('old-meta', 'Converted', 'converted', 8)).applied).toBe(false);
            expect((await apply('new-meta', 'Not Qualified', 'not_qualified', 10)).applied).toBe(true);
            expect((await apply('case-variant', 'Not qualified', 'not_qualified', 12)).applied).toBe(true);
            expect((await db.query<{ repaired: number }>('SELECT repair_chatbot_page_outcome_tags($1,1) AS repaired', [pageId])).rows[0].repaired).toBe(0);
            await db.query("DELETE FROM contact_tags ct USING tags t WHERE ct.tag_id=t.id AND ct.contact_id=$1 AND t.system_key='stage_history:not_qualified'", [contactId]);
            expect((await db.query<{ repaired: number }>('SELECT repair_chatbot_page_outcome_tags($1,1) AS repaired', [pageId])).rows[0].repaired).toBe(1);
            await expect(apply('cross-page', 'Qualified', 'qualified', 11, '00000000-0000-4000-8000-000000000002')).rejects.toThrow('Contact does not belong');
            const tags = (await db.query<{ name: string }>('SELECT t.name FROM tags t JOIN contact_tags ct ON ct.tag_id=t.id WHERE ct.contact_id=$1 ORDER BY t.name', [contactId])).rows.map(row => row.name);
            expect(tags).toEqual(expect.arrayContaining(['Existing owner tag', 'History: Qualified', 'History: Converted', 'History: Not Qualified', 'History: Order Created', 'History: Intake', 'History: Consultation booked']));
            expect(tags.filter(tag => tag === 'History: Not Qualified')).toHaveLength(1);
            expect(tags).not.toContain('Paid / Availed Service');
            expect((await db.query<{ allowed: boolean }>("SELECT has_function_privilege('anon','public.apply_messenger_lead_stage(uuid,uuid,text,text,text,timestamptz)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false);
            const claimed = (await db.query<{ id: string }>('SELECT id FROM claim_messenger_stage_pages(6)')).rows;
            expect(claimed).toHaveLength(2);
            expect((await db.query('SELECT id FROM claim_messenger_stage_pages(6)')).rows).toHaveLength(0);
            await db.exec(migration);
            expect((await db.query('SELECT * FROM contact_tags')).rows).toHaveLength(tags.length);
        } finally { await db.close(); }
    }, 30000);
});
