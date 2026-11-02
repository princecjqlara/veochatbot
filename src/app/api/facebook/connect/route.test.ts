import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), db: vi.fn(), verify: vi.fn(), subscribe: vi.fn(), templates: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: m.db }));
vi.mock('@/lib/facebook', () => ({ subscribePageToAppWebhook: m.subscribe, getPageTemplates: m.templates, createUtilityTemplate: vi.fn(), isFacebookReauthRequired: (error: any) => Boolean(error?.requiresReauth) }));
vi.mock('@/lib/facebook-page-connection', async () => ({ ...await vi.importActual<any>('@/lib/facebook-page-connection'), verifyFacebookPageConnection: m.verify }));
vi.mock('@/lib/facebook-templates', () => ({ UTILITY_TEMPLATES: [] }));
import { FacebookPageConnectionError } from '@/lib/facebook-page-connection';
import { POST } from './route';
const request = (body: any = { fbPageId: '100', name: 'My Page', accessToken: 'private-token' }) => new Request('https://app.test/api/facebook/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) as NextRequest;
function storage(options: { existing?: boolean; lookupError?: any; linkError?: any; hanging?: boolean } = {}) {
 const update = vi.fn(), upsert = vi.fn(), link = vi.fn();
 const response = (value: any) => {
  const builder: any = { then: (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject) };
  for (const key of ['eq', 'select', 'single', 'maybeSingle', 'abortSignal']) builder[key] = vi.fn(() => builder);
  return builder;
 };
 const lookup = response({ data: options.existing === false ? null : { id: 'page-row' }, error: options.lookupError || null });
 if (options.hanging) lookup.then = () => new Promise(() => {});
 update.mockImplementation(() => response({ data: { id: 'page-row' }, error: null }));
 upsert.mockImplementation(() => response({ data: { id: 'page-row' }, error: null }));
 link.mockImplementation(() => response({ data: { page_id: 'page-row' }, error: options.linkError || null }));
 const from = vi.fn((table: string) => table === 'pages' ? { select: () => lookup, update, upsert } : { upsert: link });
 m.db.mockReturnValue({ from }); return { from, update, upsert, link };
}
beforeEach(() => { vi.clearAllMocks(); m.session.mockResolvedValue({ user: { id: 'owner' } }); m.verify.mockResolvedValue({ id: '100', name: 'Verified Page' }); m.subscribe.mockResolvedValue(undefined); m.templates.mockResolvedValue([]); });
afterEach(() => { vi.useRealTimers(); });
describe('Facebook Connect completion', () => {
 it('verifies the Page, saves the token and membership, then confirms webhook subscription', async () => {
  const db = storage(); const response = await POST(request()), body = await response.json();
  expect(response.status).toBe(200); expect(body).toMatchObject({ success: true, pageId: 'page-row', webhookSubscribed: true });
  expect(m.verify).toHaveBeenCalledWith('100', 'private-token');
  expect(db.update).toHaveBeenCalledWith(expect.objectContaining({ name: 'Verified Page', access_token: 'private-token' }));
  expect(m.verify.mock.invocationCallOrder[0]).toBeLessThan(db.update.mock.invocationCallOrder[0]);
  expect(db.link.mock.invocationCallOrder[0]).toBeLessThan(m.subscribe.mock.invocationCallOrder[0]);
  expect(m.subscribe).toHaveBeenCalledWith('100', 'private-token', ['messages', 'messaging_postbacks', 'message_echoes'], expect.any(AbortSignal));
  expect(JSON.stringify(body)).not.toContain('private-token');
 });
 it('creates a new Page idempotently so repeated Connect requests cannot conflict', async () => {
  const db = storage({ existing: false }); expect((await POST(request())).status).toBe(200);
  expect(db.upsert).toHaveBeenCalledWith(expect.objectContaining({ fb_page_id: '100' }), { onConflict: 'fb_page_id' });
 });
 it('never interprets a failed lookup as a missing Page or starts writes', async () => {
  const db = storage({ lookupError: { code: 'PGRST002', message: 'internal' } });
  const response = await POST(request()); expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ success: false, code: 'DATABASE_UNAVAILABLE', retryable: true });
  expect(db.update).not.toHaveBeenCalled(); expect(db.upsert).not.toHaveBeenCalled(); expect(m.verify).not.toHaveBeenCalled(); expect(m.subscribe).not.toHaveBeenCalled();
 });
 it('ends an unresponsive database lookup without claiming a connection was saved', async () => {
  vi.useFakeTimers(); const db = storage({ hanging: true }); const pending = POST(request()); await vi.advanceTimersByTimeAsync(10000);
  const response = await pending; expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ success: false, code: 'DATABASE_UNAVAILABLE' }); expect(db.update).not.toHaveBeenCalled();
 });
 it('preserves the existing token when Page validation rejects replacement credentials', async () => {
  const db = storage(); m.verify.mockRejectedValueOnce(new FacebookPageConnectionError('Wrong Page', 'FACEBOOK_PAGE_TOKEN_MISMATCH', 409, true));
  const response = await POST(request()); expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ requiresReauth: true });
  expect(db.update).not.toHaveBeenCalled(); expect(db.link).not.toHaveBeenCalled();
 });
 it('retains saved access but reports incomplete setup when webhook authorization fails', async () => {
  const db = storage(); m.subscribe.mockRejectedValueOnce(Object.assign(new Error('internal token details'), { requiresReauth: true }));
  const response = await POST(request()), body = await response.json();
  expect(response.status).toBe(409); expect(body).toMatchObject({ success: false, saved: true, pageId: 'page-row', code: 'WEBHOOK_SUBSCRIPTION_FAILED', requiresReauth: true });
  expect(db.link).toHaveBeenCalled(); expect(JSON.stringify(body)).not.toContain('internal token details'); expect(m.templates).not.toHaveBeenCalled();
 });
 it('does not enable webhook or claim success when Page membership could not be saved', async () => {
  storage({ linkError: { code: 'DATABASE_ERROR' } }); const response = await POST(request());
  expect(response.status).toBe(500); expect(await response.json()).toMatchObject({ success: false }); expect(m.subscribe).not.toHaveBeenCalled();
 });
 it('requires authentication and validates fields before reading or writing Pages', async () => {
  m.session.mockResolvedValueOnce(null); expect((await POST(request())).status).toBe(401);
  for (const value of [null, {}, { fbPageId: 'not-a-page', name: 'Name', accessToken: 'token' }]) expect((await POST(request(value))).status).toBe(400);
  expect(m.db).not.toHaveBeenCalled();
 });
});
