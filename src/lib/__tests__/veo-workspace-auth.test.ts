import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn() }));
import { getToken } from 'next-auth/jwt';
import { middleware } from '@/middleware';
import { passwordHash, passwordMatches } from '@/lib/veo-workspace';

describe('VEO authentication boundary', () => {
    beforeEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
    afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
    it('accepts one-character, whitespace and long passwords without truncating their identity', async () => {
        for (const password of ['a', ' ', 'x'.repeat(90) + 'one']) {
            const hashed = await passwordHash(password);
            expect(hashed).not.toContain(password.length < 4 ? 'unlikely-plain-marker' : password);
            expect(await passwordMatches(password, hashed)).toBe(true);
            expect(await passwordMatches(password + 'x', hashed)).toBe(false);
        }
        await expect(passwordHash('')).rejects.toThrow();
    }, 20000);
    it('rejects unsigned cron requests and anonymous API access', async () => {
        vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true'); vi.stubEnv('CRON_SECRET', 'secret');
        expect((await middleware(new NextRequest('https://veo.test/api/cron/chatbot'))).status).toBe(401);
        vi.mocked(getToken).mockResolvedValue(null);
        expect((await middleware(new NextRequest('https://veo.test/api/pages'))).status).toBe(401);
        expect((await middleware(new NextRequest('https://veo.test/api/pages/anything/sync'))).status).toBe(410);
    });
    it('checks current stored roles and resource scopes even with an existing session', async () => {
        vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true'); vi.mocked(getToken).mockResolvedValue({ id: 'worker' });
        const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ role: 'member', launch_at: '2026-11-05T00:00:00Z', page_ids: [] })))
            .mockResolvedValueOnce(new Response('false'));
        vi.stubGlobal('fetch', fetcher);
        expect((await middleware(new NextRequest('https://veo.test/api/pages/00000000-0000-4000-8000-000000000001/contacts'))).status).toBe(403);
        expect(fetcher.mock.calls[1][0]).toContain('veo_authorize_resources');
        fetcher.mockImplementation(async () => new Response(JSON.stringify({ role: 'member', launch_at: '2026-11-05T00:00:00Z' })));
        expect((await middleware(new NextRequest('https://veo.test/api/facebook/connect', { method: 'POST' }))).status).toBe(410);
        expect((await middleware(new NextRequest('https://veo.test/api/ad-calendar'))).status).toBe(403);
        expect((await middleware(new NextRequest('https://veo.test/api/ad-quality/performance'))).status).toBe(403);
        vi.unstubAllGlobals();
    });
    it('passes only the authenticated identity sync to its owner-scoped handler', async () => {
        vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true');
        const request = new NextRequest('https://veo.test/api/workspace/contacts/sync', { method: 'POST' });
        vi.mocked(getToken).mockResolvedValue(null);
        expect((await middleware(request)).status).toBe(401);
        vi.mocked(getToken).mockResolvedValue({ id: 'owner' });
        const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
        expect((await middleware(request)).status).toBe(200);
        expect((await middleware(new NextRequest('https://veo.test/api/pages/page/sync'))).status).toBe(410);
        expect((await middleware(new NextRequest('https://veo.test/api/workspace/contacts/history/sync'))).status).toBe(410);
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('rejects a previously issued Facebook session belonging to any account before reading workspace data', async () => {
        vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true');
        vi.mocked(getToken).mockResolvedValue({ id: 'member', facebookId: 'old-facebook-binding' });
        const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
        expect((await middleware(new NextRequest('https://veo.test/api/workspace'))).status).toBe(401);
        expect(fetcher).not.toHaveBeenCalled();
    });
});
