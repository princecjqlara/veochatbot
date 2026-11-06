import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ token: vi.fn(), fetch: vi.fn(), role: 'member', pages: ['page'] }));
vi.mock('next-auth/jwt', () => ({ getToken: m.token }));
import { middleware } from '@/middleware';
beforeEach(() => { vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true'); vi.stubGlobal('fetch', m.fetch); m.token.mockResolvedValue({ id: 'worker' }); m.fetch.mockImplementation(async () => new Response(JSON.stringify({ user_id: 'worker', role: m.role, launch_at: '2026-11-05', page_ids: m.pages }))); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
it.each(['member', 'manager'])('blocks ads and the legacy calendar API for %s', async role => {
    m.role = role;
    for (const path of ['/api/ad-calendar', '/api/ad-quality', '/api/ad-quality/performance']) expect((await middleware(new NextRequest('https://veo.test' + path))).status).toBe(403);
});
it('allows Team Leader reporting for assigned Pages, and blocks foreign Pages and mutations', async () => {
    m.role = 'team_leader';
    for (const path of ['/api/ad-calendar', '/api/ad-quality', '/api/ad-quality/connection', '/api/ad-quality/performance', '/api/ad-quality/contacts']) expect((await middleware(new NextRequest(`https://veo.test${path}?pageId=page`))).status).toBe(200);
    expect((await middleware(new NextRequest('https://veo.test/api/ad-quality?pageId=foreign'))).status).toBe(403);
    expect((await middleware(new NextRequest('https://veo.test/api/ad-quality/connection', { method: 'POST', headers: { Origin: 'https://veo.test' } }))).status).toBe(403);
});
