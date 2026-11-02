import { describe, expect, it } from 'vitest';
import { calendarRegistryEntries, markRetainedCalendarCacheSql } from '../../../scripts/lib/calendar-source-registry.mjs';
import { PGlite } from '@electric-sql/pglite';
const pages = [{ id: 'p1', fb_page_id: '100' }, { id: 'p2', fb_page_id: '300' }];
const row = { page_id: 'p1', fb_page_id: '100', psid: '200', complete: true, source_cutoff_at: '2026-01-01T00:00:00Z', archive_path: 'data/history.json', archive_sha256: 'a'.repeat(64), contact_id: 'old-archive-id' };
describe('calendar histories from the full retained registry', () => {
 it('labels newly imported exports as audited while retaining equal/newer live provenance and payment evidence', async () => {
  const db = await PGlite.create();
  try {
   await db.exec(`CREATE TABLE contact_conversion_cache(contact_id text,page_id text,source_cutoff_at timestamptz,source_kind text,payment_evidence_id text);
    CREATE TABLE repair_input(contact_id text,page_id text,projection_cache jsonb); CREATE TABLE repair_before(id text,conversion_cache jsonb);
    INSERT INTO contact_conversion_cache VALUES('new','p1','2026-02-01','live_graph','keep-1'),('same','p1','2026-02-01','live_graph','keep-2'),('newer','p1','2026-03-01','live_graph','keep-3');
    INSERT INTO repair_input SELECT contact_id,page_id,'{"source_kind":"audited_history","source_cutoff_at":"2026-02-01T00:00:00Z"}'::jsonb FROM contact_conversion_cache;
    INSERT INTO repair_before VALUES('new',NULL),('same','{"source_kind":"live_graph","source_cutoff_at":"2026-02-01T00:00:00Z"}'),('newer','{"source_kind":"live_graph","source_cutoff_at":"2026-03-01T00:00:00Z"}');`);
   await db.query(markRetainedCalendarCacheSql);
   expect((await db.query('SELECT contact_id,source_kind,payment_evidence_id FROM contact_conversion_cache ORDER BY contact_id')).rows).toEqual([
    { contact_id: 'new', source_kind: 'audited_history', payment_evidence_id: 'keep-1' },
    { contact_id: 'newer', source_kind: 'live_graph', payment_evidence_id: 'keep-3' },
    { contact_id: 'same', source_kind: 'live_graph', payment_evidence_id: 'keep-2' }
   ]);
  } finally { await db.close(); }
 }, 30000);
 it('limits to current connected Pages, resolves by Page and PSID and ignores archive contact IDs', () => {
  const result = calendarRegistryEntries([row, { ...row, page_id: 'p2', fb_page_id: '300' }], pages, ['p1']);
  expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ page: pages[0], psid: '200', hash: row.archive_sha256, explicitFull: true });
  expect(result[0]).not.toHaveProperty('contact_id');
 });
 it('deduplicates to the latest complete source and rejects conflicting identities or evidence', () => {
  const newer = { ...row, source_cutoff_at: '2026-02-01T00:00:00Z', archive_sha256: 'b'.repeat(64) };
  expect(calendarRegistryEntries([newer, row, newer], pages, ['p1'])).toHaveLength(1);
  expect(calendarRegistryEntries([newer, row], pages, ['p1'])[0].hash).toBe(newer.archive_sha256);
  for (const changed of [{ fb_page_id: '999' }, { complete: false }, { source_cutoff_at: 'invalid' }, { archive_sha256: 'invalid' }])
   expect(() => calendarRegistryEntries([{ ...row, ...changed }], pages, ['p1'])).toThrow('invalid');
  expect(() => calendarRegistryEntries([row, { ...row, archive_sha256: 'b'.repeat(64) }], pages, ['p1'])).toThrow('Conflicting');
 });
});
