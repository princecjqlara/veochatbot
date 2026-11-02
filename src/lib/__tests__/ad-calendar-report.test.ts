import { describe, expect, it, vi } from 'vitest';
import { CalendarReportError, loadCalendarReport } from '@/lib/ad-calendar-report';
const scope = { pageIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'], from: '2026-07-01T00:00:00Z', to: '2026-08-01T00:00:00Z', adId: null };
describe('complete calendar report recovery', () => {
 it('splits a timed-out report while retaining every authorized Page and its complete groups', async () => {
  let active = 0, highest = 0;
  const rpc = vi.fn(async (_name: string, args: any) => {
   active++; highest = Math.max(highest, active); await Promise.resolve(); active--;
   return args.p_page_ids.length > 2 ? { error: { code: '57014' } } : { data: { groups: args.p_page_ids.map((page_id: string) => ({ page_id, inquiries: 20 })), as_of: '2026-11-02T00:00:00Z' } };
  });
  const result = await loadCalendarReport({ rpc }, scope);
  expect(result.groups.map(group => group.page_id).sort()).toEqual(scope.pageIds);
  expect(result.groups.reduce((n, group) => n + group.inquiries, 0)).toBe(120); expect(highest).toBeLessThanOrEqual(2);
  expect(rpc.mock.calls.every(call => call[1].p_from === scope.from && call[1].p_to === scope.to && call[1].p_ad_id === null)).toBe(true);
 });
 it('rejects the whole result if any Page fails instead of publishing partial totals', async () => {
  const rpc = vi.fn(async (_name: string, args: any) => args.p_page_ids.length > 2 || args.p_page_ids.includes('p6')
   ? { error: { code: '57014' } } : { data: { groups: [{ page_id: 'p1', inquiries: 999 }] } });
  await expect(loadCalendarReport({ rpc }, scope)).rejects.toMatchObject({ code: 'CALENDAR_TIMEOUT', retryable: true });
 });
 it('never turns an invalid response or storage error into an empty successful month', async () => {
  for (const reply of [undefined, { data: null }, { data: { groups: null } }, { error: { code: 'PGRST202' } }]) {
   const rpc = vi.fn().mockResolvedValue(reply);
   await expect(loadCalendarReport({ rpc }, scope)).rejects.toBeInstanceOf(CalendarReportError);
   expect(rpc).toHaveBeenCalledTimes(1);
  }
 });
 it('returns an empty authorized scope without querying storage', async () => {
  const rpc = vi.fn(); expect((await loadCalendarReport({ rpc }, { ...scope, pageIds: [] })).groups).toEqual([]); expect(rpc).not.toHaveBeenCalled();
 });
});
