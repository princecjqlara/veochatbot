import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), scope: vi.fn(), grant: vi.fn(), pages: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/veo-workspace', () => ({ workspaceScope: m.scope }));
vi.mock('@/lib/facebook-page-authorization', () => ({ readFacebookPageGrant: m.grant }));
vi.mock('@/lib/facebook', () => ({ getFacebookPages: m.pages }));
import { GET } from './route';
const get = () => GET(new NextRequest('https://veo.test/api/facebook/pages'));
beforeEach(() => { vi.clearAllMocks(); m.session.mockResolvedValue({ user: { id: 'owner' } }); m.scope.mockResolvedValue({ role: 'owner', user_id: 'owner', launch_at: '2026-11-01' }); m.grant.mockResolvedValue({ token: 'private-token', expiresAt: 'later' }); });
it('returns every authorized Page without returning credentials or filtering new Page IDs', async () => {
    m.pages.mockResolvedValue(Array.from({ length: 1001 }, (_, index) => ({ id: String(index + 1), name: 'Page ' + index, access_token: 'private-page-token', tasks: ['MESSAGING'] })));
    const response = await get(), body = await response.json(); expect(response.status).toBe(200); expect(body.pages).toHaveLength(1001);
    expect(body.pages.at(-1).id).toBe('1001'); expect(JSON.stringify(body)).not.toContain('private-');
});
it('requires renewed authorization without pretending that no Pages exist', async () => {
    m.grant.mockResolvedValue(null); const response = await get(); expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('FACEBOOK_AUTHORIZATION_REQUIRED'); expect(m.pages).not.toHaveBeenCalled();
});
it('reports revoked Facebook access as a permission refresh requirement', async () => {
    m.pages.mockRejectedValue(Object.assign(new Error('upstream credentials omitted'), { requiresReauth: true }));
    const response = await get(); expect(response.status).toBe(409); expect((await response.json()).code).toBe('FACEBOOK_AUTHORIZATION_REQUIRED');
});
it.each(['member', 'manager', 'team_leader'])('does not disclose the Page directory to %s', async role => {
    m.scope.mockResolvedValue({ role, launch_at: '2026-11-01' }); expect((await get()).status).toBe(403); expect(m.grant).not.toHaveBeenCalled();
});
