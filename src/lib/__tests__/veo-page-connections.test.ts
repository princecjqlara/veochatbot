import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), scope: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/veo-workspace', () => ({ workspaceScope: m.scope }));
import { decryptPageGrant, encryptPageGrant, PAGE_AUTH_COOKIE, pageGrantCookie, pageSetupFailure, readPageGrantCookie, requirePageOwner } from '../veo-page-connections';
const request = (origin = 'https://veo.test') => new NextRequest('https://veo.test/api/facebook/connect', { method: 'POST', headers: { origin } });
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('NEXTAUTH_SECRET', 'a-private-test-key'); m.session.mockResolvedValue({ user: { id: 'owner' } }); m.scope.mockResolvedValue({ user_id: 'owner', role: 'owner', launch_at: '2026-11-01' }); });
afterEach(() => { vi.unstubAllEnvs(); });
it('requires a current Owner and same-origin writes', async () => {
    expect((await requirePageOwner(request(), true)).role).toBe('owner');
    await expect(requirePageOwner(request('https://other.test'), true)).rejects.toMatchObject({ status: 403 });
    m.session.mockResolvedValue(null); await expect(requirePageOwner(request())).rejects.toMatchObject({ status: 401 });
});
it.each(['member', 'manager', 'team_leader'])('rejects %s even when an account is authenticated', async role => {
    m.scope.mockResolvedValue({ role, launch_at: '2026-11-01' });
    await expect(requirePageOwner(request())).rejects.toMatchObject({ status: 403, code: 'OWNER_REQUIRED' });
});
it('encrypts grants, rejects tampering and binds the authorization cookie to the signed-in actor', () => {
    const privateToken = 'never-return-this-facebook-token', encrypted = encryptPageGrant(privateToken);
    expect(encrypted).not.toContain(privateToken); expect(decryptPageGrant(encrypted)).toBe(privateToken);
    const bytes = Buffer.from(encrypted, 'base64url'); bytes[30] ^= 1;
    expect(() => decryptPageGrant(bytes.toString('base64url'))).toThrow('authorization expired');
    const id = '00000000-0000-4000-8000-000000000001';
    const req = new NextRequest('https://veo.test/api/facebook/pages', { headers: { Cookie: PAGE_AUTH_COOKIE + '=' + pageGrantCookie(id, 'owner') } });
    expect(readPageGrantCookie(req, 'owner')).toBe(id); expect(readPageGrantCookie(req, 'another-owner')).toBeNull();
});
it('does not expose Graph or database credentials in unexpected errors', async () => {
    const response = pageSetupFailure(new Error('upstream rejected secret-page-token'));
    expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain('secret-page-token');
});
