import { describe, expect, it, vi } from 'vitest';
import { loadCalendarCoverage } from '../ad-calendar-coverage';
function database(results: Record<string, any>) {
 const scopes: any[] = [];
 return { scopes, from: vi.fn((table: string) => {
  const query: any = { then: (resolve: any, reject: any) => Promise.resolve(results[table]).then(resolve, reject) };
  for (const method of ['select', 'eq', 'is', 'order', 'limit', 'abortSignal']) query[method] = () => query;
  query.in = (field: string, ids: string[]) => { scopes.push({ table, field, ids }); return query; };
  return query;
 }) };
}
describe('calendar coverage', () => {
 it('reports Page-wide missing inquiry dates and scopes every source to the authorized Pages', async () => {
  const db = database({ contacts: { count: 100 }, ad_lead_cohorts: { count: 7 }, contact_conversion_cache: { data: [{ source_cutoff_at: '2026-11-02T00:00:00Z' }] } });
  expect(await loadCalendarCoverage(db, ['p'])).toEqual({ available: true, page_contacts_total: 100, contacts_missing_inquiry_date: 7, latest_history_check_at: '2026-11-02T00:00:00Z' });
  expect(db.scopes).toHaveLength(3); expect(db.scopes.every(scope => scope.field === 'page_id' && scope.ids.join() === 'p')).toBe(true);
 });
 it.each([
  { contacts: { error: { code: 'PGRST002' } }, ad_lead_cohorts: { count: 0 } },
  { contacts: { count: 100 }, ad_lead_cohorts: { count: null } },
  { contacts: { count: 10 }, ad_lead_cohorts: { count: 11 } }
 ])('keeps unavailable or inconsistent coverage unknown without breaking the report', async results => {
  const result = await loadCalendarCoverage(database(results), ['p']);
  expect(result).toMatchObject({ available: false, page_contacts_total: null, contacts_missing_inquiry_date: null });
 });
 it('distinguishes a genuinely empty Page from unknown coverage', async () => {
  const db = database({ contacts: { count: 0 }, ad_lead_cohorts: { count: 0 }, contact_conversion_cache: { data: [] } });
  expect(await loadCalendarCoverage(db, ['p'])).toMatchObject({ available: true, page_contacts_total: 0, contacts_missing_inquiry_date: 0 });
  await loadCalendarCoverage(db, []); expect(db.from).toHaveBeenCalledTimes(3);
 });
});
