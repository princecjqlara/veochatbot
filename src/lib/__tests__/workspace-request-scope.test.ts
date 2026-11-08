import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ token: vi.fn(), rpc: vi.fn(), legacy: vi.fn() }));
vi.mock('next-auth/jwt', () => ({ getToken: m.token }));
vi.mock('next-auth', () => ({ getServerSession: m.legacy }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ rpc: m.rpc }) }));
import { getSessionFromRequest } from '../get-session';
import { workspaceScope } from '../veo-workspace';
import { middleware } from '@/middleware';
import { GET as context } from '@/app/api/workspace/context/route';
const scope = { user_id: 'member', role: 'member', launch_at: '2026-11-05T00:00:00Z', page_ids: ['page'], worker_ids: [] };
beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true');
    m.token.mockResolvedValue({ id: 'member', name: 'Member', exp: 2_000_000_000 });
    m.rpc.mockResolvedValue({ data: scope, error: null });
});
afterEach(() => { vi.unstubAllEnvs(); });
it('makes one authoritative scope read for authentication and route access in one request', async () => {
    const request = new NextRequest('https://veo.test/api/workspace');
    const session = await getSessionFromRequest(request);
    expect(session?.user).toMatchObject({ id: 'member', role: 'member' });
    expect(await workspaceScope('member', request)).toEqual(scope);
    await Promise.all([workspaceScope('member', request), workspaceScope('member', request)]);
    expect(m.rpc).toHaveBeenCalledOnce();
    expect(m.legacy).not.toHaveBeenCalled();
});
it('uses one scope RPC across the middleware and a complete workspace context response', async () => {
    const request = new NextRequest('https://veo.test/api/workspace/context?view=profile');
    expect((await middleware(request)).status).toBe(200);
    const response = await context(request);
    expect(response.status).toBe(200);
    expect((await response.json()).scope).toMatchObject({ user_id: 'member', role: 'member' });
    expect(m.rpc).toHaveBeenCalledOnce();
});
it('rechecks access on the next request and never shares a different actor scope', async () => {
    const request = new NextRequest('https://veo.test/api/workspace');
    await workspaceScope('member', request);
    await workspaceScope('other', request);
    expect(m.rpc).toHaveBeenCalledTimes(2);
    m.rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await getSessionFromRequest(new NextRequest(request.url))).toBeNull();
    expect(m.rpc).toHaveBeenCalledTimes(3);
});
it('rejects unsigned and old Facebook identities before any database read', async () => {
    for (const token of [null, { id: 'member', facebookId: 'old' }, { id: 'member', accessToken: 'old' }]) {
        m.token.mockResolvedValueOnce(token);
        expect(await getSessionFromRequest(new NextRequest('https://veo.test/api/workspace'))).toBeNull();
    }
    expect(m.rpc).not.toHaveBeenCalled();
});
it('denies an unavailable scope without a second retry or a misleading signed-out response', async () => {
    m.rpc.mockResolvedValue({ error: { code: 'SUPABASE_CIRCUIT_OPEN' }, data: null });
    const request = new NextRequest('https://veo.test/api/workspace');
    await expect(getSessionFromRequest(request)).rejects.toMatchObject({ status: 503 });
    await expect(workspaceScope('member', request)).rejects.toMatchObject({ status: 503 });
    expect(m.rpc).toHaveBeenCalledOnce();
});
