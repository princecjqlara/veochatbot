import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const token = vi.hoisted(() => vi.fn());
vi.mock('next-auth/jwt', () => ({ getToken: token }));
import { middleware } from '@/middleware';
beforeEach(() => { vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true');vi.stubEnv('VEO_DATABASE_RECOVERY_MODE', 'false');vi.stubEnv('CRON_SECRET', 'cron');vi.stubEnv('VEO_BACKGROUND_PAUSED_UNTIL', new Date(Date.now() + 30000).toISOString()); });
afterEach(() => { vi.unstubAllEnvs();vi.unstubAllGlobals();vi.clearAllMocks(); });
it('defers authorized scheduled work without opening a database connection or reporting success', async () => {
    const fetcher = vi.fn();vi.stubGlobal('fetch', fetcher);
    const response = await middleware(new NextRequest('https://veo.test/api/cron/workspace', { headers: { Authorization: 'Bearer cron' } }));
    expect(response.status).toBe(503);expect(response.headers.get('retry-after')).toBeTruthy();
    expect(await response.json()).toMatchObject({ ok: false, skipped: true, reason: 'temporary_background_pause' });
    expect(fetcher).not.toHaveBeenCalled();expect(token).not.toHaveBeenCalled();
});
it('retains cron authentication during the pause', async () => {
    expect((await middleware(new NextRequest('https://veo.test/api/cron/workspace'))).status).toBe(401);
});
it('keeps staff requests, sign-in and webhook intake on their normal authorization paths', async () => {
    token.mockResolvedValue({ id: 'member' });
    for (const path of ['/api/workspace/context', '/api/auth/session', '/api/auth/callback/credentials', '/api/facebook/webhook']) {
        expect((await middleware(new NextRequest('https://veo.test' + path))).headers.get('x-middleware-next')).toBe('1');
    }
});
it.each(['', 'invalid', '2000-01-01T00:00:00Z'])('automatically resumes normal handling with an expired or absent pause: %s', async value => {
    vi.stubEnv('VEO_BACKGROUND_PAUSED_UNTIL', value);
    expect((await middleware(new NextRequest('https://veo.test/api/cron/workspace', { headers: { Authorization: 'Bearer cron' } }))).headers.get('x-middleware-next')).toBe('1');
});
