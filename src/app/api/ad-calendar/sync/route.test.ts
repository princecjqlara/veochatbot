import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), ids: vi.fn(), db: vi.fn(), rpc: vi.fn(), read: vi.fn(), upsert: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/page-access', () => ({ getUserPageIds: m.ids }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: m.db }));
vi.mock('@/lib/facebook-ad-catalog', () => ({ readMetaAds: m.read, MetaAdAccessError: class extends Error {} }));
import { POST } from './route';
const request = (patch: any = {}, origin = 'https://app.test') => new NextRequest('https://app.test/api/ad-calendar/sync', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: 'act_22', adIds: ['11'], pageId: 'p', from: '2020-01-01', to: '2020-01-02', ...patch }) });
const row = { ad_id: '11', account_id: '22', account_currency: 'PHP', date_start: '2020-01-01', date_stop: '2020-01-01', spend: '100', impressions: '1000', clicks: '40', actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '5' }] };
beforeEach(() => {
 vi.clearAllMocks(); m.session.mockResolvedValue({ user: { id: 'member' }, accessToken: 'synthetic-test-only' }); m.ids.mockResolvedValue(['p']);
 m.rpc.mockResolvedValue({ data: [{ ad_id: '11', page_id: 'p', ad_account_id: '22' }], error: null }); m.upsert.mockResolvedValue({ error: null }); m.from.mockReturnValue({ upsert: m.upsert }); m.db.mockReturnValue({ rpc: m.rpc, from: m.from });
 m.read.mockImplementation(async (path: string) => path === 'act_22' ? { id: 'act_22', currency: 'PHP', timezone_name: 'Asia/Manila' } : { data: [row] });
});
describe('complete read-only ad-day import', () => {
 it('rejects missing authentication, cross-origin requests, unrelated Pages and unrelated ads before requesting Meta data', async () => {
  m.session.mockResolvedValueOnce(null); expect((await POST(request())).status).toBe(401); expect((await POST(request({}, 'https://evil.test'))).status).toBe(403);
  expect((await POST(request({ pageId: 'foreign' }))).status).toBe(403); expect((await POST(request({ adIds: ['999'] }))).status).toBe(403); expect(m.read).not.toHaveBeenCalled();
 });
 it('requires real ad-account access and bounded reporting batches', async () => {
  m.session.mockResolvedValueOnce({ user: { id: 'member' } }); expect((await POST(request())).status).toBe(409);
  expect((await POST(request({ to: '2020-01-08' }))).status).toBe(400); expect(m.read).not.toHaveBeenCalled();
 });
 it('atomically publishes a completed report and marks only verified no-activity days as zero', async () => {
  const response = await POST(request()), body = await response.json(); expect(response.status).toBe(200); expect(body.saved).toBe(2);
  const rows = m.upsert.mock.calls[0][0]; expect(rows[0]).toMatchObject({ amount: 100, messaging_started: 5, report_complete: true, reported_zero: false });
  expect(rows[1]).toMatchObject({ spend_date: '2020-01-02', amount: 0, messaging_started: 0, reported_zero: true });
  expect(m.read).toHaveBeenCalledWith('act_22/insights', 'synthetic-test-only', expect.objectContaining({ action_report_time: 'conversion', use_unified_attribution_setting: 'true', time_increment: '1', filtering: JSON.stringify([{ field: 'ad.id', operator: 'IN', value: ['11'] }]) }));
  expect(m.from).toHaveBeenCalledWith('ad_daily_spend'); expect(m.upsert).toHaveBeenCalledTimes(1);
 });
 it('never saves partial reports, invents zeros after missing cursors, or adds duplicate ad-day breakdowns', async () => {
  m.read.mockResolvedValueOnce({ id: 'act_22', currency: 'PHP', timezone_name: 'Asia/Manila' }).mockResolvedValueOnce({ data: [row], paging: { next: 'missing-cursor' } });
  expect((await POST(request())).status).toBe(503); expect(m.upsert).not.toHaveBeenCalled();
  m.read.mockResolvedValueOnce({ id: 'act_22', currency: 'PHP', timezone_name: 'Asia/Manila' }).mockResolvedValueOnce({ data: [row, row] });
  expect((await POST(request())).status).toBe(503); expect(m.upsert).not.toHaveBeenCalled();
 });
 it('retains native account-day boundaries instead of prorating UTC spend onto PHT cohorts', async () => {
  m.read.mockResolvedValueOnce({ id: 'act_22', currency: 'PHP', timezone_name: 'UTC' }).mockResolvedValueOnce({ data: [] });
  const body = await (await POST(request())).json(); expect(body.pht_aligned).toBe(false); expect(m.upsert.mock.calls[0][0].every((value: any) => value.pht_aligned === false)).toBe(true);
 });
});
