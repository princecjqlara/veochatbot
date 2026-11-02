import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), ids: vi.fn(), db: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/page-access', () => ({ getUserPageIds: m.ids }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: m.db }));
import { GET } from './route';
const request = (query = '') => new NextRequest('https://app.test/api/ad-calendar?month=2020-01' + query);
beforeEach(() => {
 vi.clearAllMocks(); m.session.mockResolvedValue({ user: { id: 'owner' } }); m.ids.mockResolvedValue(['p']); m.rpc.mockResolvedValue({ data: { groups: [], contacts: [], total: 0 }, error: null });
 m.db.mockReturnValue({ rpc: m.rpc, from: (table: string) => {
  const builder: any = { then: (resolve: any) => Promise.resolve({ data: table === 'pages' ? [{ id: 'p', name: 'Page' }] : [], error: null }).then(resolve) };
  for (const method of ['select', 'in', 'eq', 'gte', 'lte', 'order', 'range']) builder[method] = () => builder; return builder;
 } });
});
describe('ad calendar authorization and cohort dates', () => {
 it('returns a complete future month for browsing with unavailable actual financial results', async () => {
  const response = await GET(new NextRequest('https://app.test/api/ad-calendar?month=2099-02'));
  const body = await response.json(); expect(response.status).toBe(200); expect(body.days).toHaveLength(28);
  expect(body.days.every((day: any) => day.future)).toBe(true); expect(body.summary.profit).toBeNull();
 });
 it('requires authentication and Page access before reading financial data', async () => {
  m.session.mockResolvedValueOnce(null); expect((await GET(request())).status).toBe(401);
  expect((await GET(request('&pageId=foreign'))).status).toBe(403); expect(m.db).not.toHaveBeenCalled();
 });
 it('rejects invalid months, day boundaries, ad identifiers and contact filters', async () => {
  for (const query of ['&day=2020-02-01', '&adId=bad', '&view=contacts&day=2020-01-01&status=bad']) expect((await GET(request(query))).status).toBe(400);
  expect((await GET(new NextRequest('https://app.test/api/ad-calendar?month=2020-13'))).status).toBe(400);
 });
 it('keeps complete month bounds and private cache headers without fabricating empty revenue', async () => {
  const response = await GET(request('&pageId=p')), body = await response.json(); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(m.rpc).toHaveBeenCalledWith('get_ad_calendar_report', expect.objectContaining({ p_page_ids: ['p'], p_from: '2019-12-31T16:00:00.000Z', p_to: '2020-01-31T16:00:00.000Z' }));
  expect(body.days).toHaveLength(31); expect(body.summary.profit).toBeNull(); expect(body.summary.financial_verified).toBe(false);
 });
 it('loads the selected inquiry day cohort, not only customers who paid on that day', async () => {
  const response = await GET(request('&view=contacts&day=2020-01-02&status=paid&offset=25&pageId=p&adId=11'));
  expect(response.status).toBe(200); expect(m.rpc).toHaveBeenCalledWith('get_ad_calendar_contacts', { p_page_ids: ['p'], p_from: '2020-01-01T16:00:00.000Z', p_to: '2020-01-02T16:00:00.000Z', p_ad_id: '11', p_status: 'paid', p_offset: 25 });
 });
});
