import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), scope: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/veo-workspace', () => ({ workspaceScope: m.scope }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => m }));
import { GET } from './route';
const request = () => new NextRequest('https://veo.test/api/workspace/account-access?actor=foreign');
beforeEach(() => { vi.resetAllMocks();m.session.mockResolvedValue({ user: { id: 'owner' } });m.scope.mockResolvedValue({ user_id: 'owner', role: 'owner', launch_at: 'launched' });m.rpc.mockResolvedValue({ data: { accounts: [] } }); });
it('returns private Owner status with the authenticated actor and rejects other roles', async () => {
    const r = await GET(request());expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('no-store');expect(m.rpc).toHaveBeenCalledWith('veo_account_access', { p_actor: 'owner' });
    for (const role of ['team_leader', 'manager', 'member']) { m.scope.mockResolvedValue({ role, launch_at: 'launched' });expect((await GET(request())).status).toBe(403); }
    m.session.mockResolvedValue(null);expect((await GET(request())).status).toBe(401);
});
it('reports unavailable status without exposing database details', async () => {
    m.rpc.mockResolvedValue({ error: { code: '42501', message: 'private database diagnostic' } });const r = await GET(request());expect(r.status).toBe(503);expect(JSON.stringify(await r.json())).not.toContain('private database');
});
