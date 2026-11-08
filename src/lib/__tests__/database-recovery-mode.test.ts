import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const token = vi.hoisted(() => vi.fn());
vi.mock('next-auth/jwt', () => ({ getToken: token }));
import { middleware } from '@/middleware';
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('VEO_DATABASE_RECOVERY_MODE', 'true'); vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true'); vi.stubEnv('CRON_SECRET', 'cron'); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it.each(['workspace', 'contact-profiles', 'meta-ads-sync', 'chatbot', 'messaging-auto-tag'])('stops %s before any route or database work', async job => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const response = await middleware(new NextRequest('https://veo.test/api/cron/' + job, { headers: { Authorization: 'Bearer cron' } }));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ skipped: true, reason: 'database_recovery' });
    expect(token).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it('preserves cron authentication during recovery', async () => {
    expect((await middleware(new NextRequest('https://veo.test/api/cron/workspace'))).status).toBe(401);
});
it.each(['/api/workspace', '/api/workspace/handoff', '/api/pages', '/api/telegram/webhook', '/api/auth/session'])('quiesces database-backed requests: %s', async path => {
    const response = await middleware(new NextRequest('https://veo.test' + path));
    expect(response.status).toBe(503); expect(response.headers.get('retry-after')).toBe('60');
    expect((await response.json()).code).toBe('DATABASE_RECOVERY'); expect(token).not.toHaveBeenCalled();
});
it('keeps the credentials callback compatible with NextAuth redirect:false', async () => {
    const response = await middleware(new NextRequest('https://veo.test/api/auth/callback/credentials', { method: 'POST' }));
    expect(response.status).toBe(503); expect(new URL((await response.json()).url).searchParams.get('error')).toBe('DatabaseRecovery');
    expect(token).not.toHaveBeenCalled();
});
it.each(['/api/auth/csrf', '/api/auth/providers', '/api/auth/signout', '/api/facebook/webhook'])('preserves safe auth and durable webhook ingestion: %s', async path => {
    expect((await middleware(new NextRequest('https://veo.test' + path))).headers.get('x-middleware-next')).toBe('1');
    expect(token).not.toHaveBeenCalled();
});
it('resumes normal authentication after recovery mode is disabled', async () => {
    vi.stubEnv('VEO_DATABASE_RECOVERY_MODE', 'false'); token.mockResolvedValue(null);
    expect((await middleware(new NextRequest('https://veo.test/api/workspace'))).status).toBe(401);
    expect(token).toHaveBeenCalledOnce();
});
