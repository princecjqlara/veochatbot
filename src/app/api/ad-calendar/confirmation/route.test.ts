import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), ids: vi.fn(), db: vi.fn(), source: {} as any }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/page-access', () => ({ getUserPageIds: m.ids }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: m.db }));
import { GET } from './route';
const page = '00000000-0000-4000-8000-000000000001', contact = '10000000-0000-4000-8000-000000000001';
const request = (pageId = page) => new NextRequest('https://app.test/api/ad-calendar/confirmation?pageId=' + pageId + '&contactId=' + contact);
beforeEach(() => {
 vi.clearAllMocks(); m.session.mockResolvedValue({ user: { id: 'owner' } }); m.ids.mockResolvedValue([page]);
 m.source = { complete_history: true, first_inquiry_at: '2020-01-01T00:00:00Z', payment_at: '2020-01-02T00:00:00Z', source_cutoff_at: '2020-01-03T00:00:00Z', payment_evidence_id: 'ack' };
 m.db.mockReturnValue({ from: (table: string) => {
  const chain: any = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: table === 'pages' ? { fb_page_id: 'fb-page', access_token: 'secret-page-token' } : m.source, error: null }) };
  return chain;
 } });
});
afterEach(() => { vi.unstubAllGlobals(); });
describe('calendar payment evidence', () => {
 it('requires authentication and Page membership before accessing source messages', async () => {
  m.session.mockResolvedValueOnce(null); expect((await GET(request())).status).toBe(401);
  expect((await GET(request('00000000-0000-4000-8000-000000000002'))).status).toBe(403);
  expect(m.db).not.toHaveBeenCalled();
 });
 it('opens exact Page-authored payment evidence without creating or claiming a ledger receipt', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'ack', message: 'Payment received PHP 500, thank you!', from: { id: 'fb-page' }, created_time: '2020-01-02T00:00:00Z' }) }));
  const response = await GET(request()), body = await response.json();
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(body).toMatchObject({ amount: 500, currency: 'PHP', verification: 'conversation_documented', ledger_verified: false });
  expect(JSON.stringify(body)).not.toContain('secret-page-token');
 });
 it('rejects customer-authored or changed evidence and invalid cached confirmation dates', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'ack', message: 'Payment received PHP 500', from: { id: 'customer' }, created_time: '2020-01-02T00:00:00Z' }) }));
  expect((await GET(request())).status).toBe(409);
  m.source.payment_at = '2020-02-01T00:00:00Z'; expect((await GET(request())).status).toBe(409);
 });
});
