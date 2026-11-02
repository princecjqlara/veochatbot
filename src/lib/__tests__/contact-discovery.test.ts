import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { normalizeContactName } from '../contact-names';
import { discoverContactsSql, discoveryJournalSql, newConversationContactRows } from '../../../scripts/lib/contact-discovery.mjs';
const page = { id: '00000000-0000-4000-8000-000000000001', fb_page_id: '100' };
describe('connected-Page new contact discovery', () => {
 it('discovers genuinely new individual conversations and deduplicates repeated threads', () => {
  const conversation = (id: string, people: any[], updated_time = '2026-11-01T01:00:00Z') => ({ id, participants: { data: [{ id: '100' }, ...people] }, updated_time });
  const rows = newConversationContactRows(page, [
   conversation('new', [{ id: '200', name: 'New customer' }]),
   conversation('repeat', [{ id: '200', name: 'New customer' }]),
   conversation('known', [{ id: '300' }]), conversation('group', [{ id: '400' }, { id: '500' }]),
   conversation('placeholder', [{ id: '600', name: 'Facebook user' }], 'not-a-date')
  ], new Set(['300']), normalizeContactName, Date.parse('2026-11-02T00:00:00Z'));
  expect(rows).toHaveLength(2); expect(rows[0]).toMatchObject({ psid: '200', name: 'New customer' });
  expect(rows[1]).toMatchObject({ psid: '600', name: null, last_interaction_at: null });
  expect(rows.every((row: any) => !('first_interaction_at' in row))).toBe(true);
 });
 it('inserts new contacts once, journals discovery, and preserves all existing contact controls and values', async () => {
  const db = new PGlite();
  try {
   await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA app_private;
    CREATE TABLE pages(id uuid PRIMARY KEY); INSERT INTO pages VALUES('${page.id}');
    CREATE TABLE contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),page_id uuid REFERENCES pages(id),psid text,name text,last_interaction_at timestamptz,first_interaction_at timestamptz,stage text DEFAULT 'new',bot_enabled boolean DEFAULT true,tags text[] DEFAULT '{}',UNIQUE(page_id,psid));
    INSERT INTO contacts(page_id,psid,name,stage,bot_enabled,tags) VALUES('${page.id}','200','Manually corrected name','converted',false,ARRAY['keep']);`);
   await db.exec(discoveryJournalSql);
   const rows = [{ psid: '200', name: 'Overwrite attempt', conversation_id: 'existing', last_interaction_at: null }, { psid: '300', name: 'New customer', conversation_id: 'new', last_interaction_at: '2026-11-01T01:00:00Z' }];
   expect((await db.query(discoverContactsSql, [page.id, JSON.stringify(rows)])).rows).toHaveLength(1);
   expect((await db.query(discoverContactsSql, [page.id, JSON.stringify(rows)])).rows).toHaveLength(0);
   const existing: any = (await db.query("SELECT * FROM contacts WHERE psid='200'")).rows[0];
   expect(existing).toMatchObject({ name: 'Manually corrected name', stage: 'converted', bot_enabled: false, tags: ['keep'], first_interaction_at: null });
   expect((await db.query('SELECT count(*)::int AS n FROM app_private.lead_contact_discovery_journal')).rows).toEqual([{ n: 1 }]);
   expect((await db.query("SELECT first_interaction_at FROM contacts WHERE psid='300'")).rows).toEqual([{ first_interaction_at: null }]);
  } finally { await db.close(); }
 });
});
