import { afterEach, describe, expect, it, vi } from 'vitest';
import { facebookWebhookConnectionStatus, verifyFacebookPageConnection } from '../facebook-page-connection';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('Page credentials before connection', () => {
 it('retains a missing app subscription as incomplete across reloads and leaves transport failures unknown', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json({ data: [] })).mockResolvedValueOnce(json({ data: [{ id: 'app', subscribed_fields: ['messages', 'messaging_postbacks', 'message_echoes', 'messaging_referrals'] }] })).mockRejectedValueOnce(Error('Network unavailable'));
  vi.stubGlobal('fetch', fetcher);
  expect(await facebookWebhookConnectionStatus('100', 'token', 'app')).toBe('incomplete');
  expect(await facebookWebhookConnectionStatus('100', 'token', 'app')).toBe('ready');
  expect(await facebookWebhookConnectionStatus('100', 'token', 'app')).toBe('unknown');
 });
 it('rejects legacy subscriptions missing referrals or echoes even when the correct app is present', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json({ data: [{ id: 'app', subscribed_fields: ['messages', 'messaging_postbacks', 'message_echoes'] }] }))
   .mockResolvedValueOnce(json({ data: [{ id: 'app', subscribed_fields: ['messages', 'messaging_postbacks', 'messaging_referrals'] }] }));
  vi.stubGlobal('fetch', fetcher);
  expect(await facebookWebhookConnectionStatus('100', 'token', 'app')).toBe('incomplete');
  expect(await facebookWebhookConnectionStatus('100', 'token', 'app')).toBe('incomplete');
  expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('fields')).toBe('id,subscribed_fields');
 });
 it('leaves missing event metadata unknown rather than claiming a completed connection', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ data: [{ id: 'app' }] })));
  expect(await facebookWebhookConnectionStatus('100', 'token', 'app')).toBe('unknown');
 });
 it('checks token identity and inbox access, accepts empty inboxes and keeps credentials out of URLs', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json({ id: '100', name: 'Actual Page' })).mockResolvedValueOnce(json({ data: [] }));
  vi.stubGlobal('fetch', fetcher);
  expect(await verifyFacebookPageConnection('100', 'private-page-token')).toEqual({ id: '100', name: 'Actual Page' });
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const [url, options] of fetcher.mock.calls) { expect(String(url)).not.toContain('private-page-token'); expect(options.headers.Authorization).toBe('Bearer private-page-token'); }
 });
 it('refuses a different Page token and missing messaging permission before any save', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json({ id: '999' })); vi.stubGlobal('fetch', fetcher);
  await expect(verifyFacebookPageConnection('100', 'token')).rejects.toMatchObject({ code: 'FACEBOOK_PAGE_TOKEN_MISMATCH', requiresReauth: true });
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValueOnce(json({ id: '100' })).mockResolvedValueOnce(json({ error: { code: 200, message: 'Missing Page messaging permission' } }, 403));
  await expect(verifyFacebookPageConnection('100', 'token')).rejects.toMatchObject({ code: 'FACEBOOK_REAUTH_REQUIRED', requiresReauth: true });
 });
 it('bounds a hanging Facebook check and leaves transient errors retryable', async () => {
  vi.useFakeTimers(); let signal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn((_url, options) => { signal = options.signal; return new Promise(() => {}); }));
  const check = expect(verifyFacebookPageConnection('100', 'token')).rejects.toMatchObject({ code: 'FACEBOOK_UNAVAILABLE', requiresReauth: false, retryable: true });
  await vi.advanceTimersByTimeAsync(8000); await check; expect(signal?.aborted).toBe(true);
 });
});
