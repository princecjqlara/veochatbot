import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), scope: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/veo-workspace', async original => ({ ...await original<any>(), workspaceScope: m.scope }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ rpc: m.rpc }) }));
import { GET, POST } from './route';
const id = '00000000-0000-4000-8000-000000000001';
const body = { worker_id: id, carry_enabled: true, max_carry: 10, capacity_multiplier: 2, fallback_cpa_minor: 10000 };
const request = (b: any = body, origin = 'https://veo.test') => new NextRequest('https://veo.test/api/workspace/quota-policy', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
beforeEach(() => { vi.resetAllMocks(); m.session.mockResolvedValue({ user: { id } }); m.scope.mockResolvedValue({ user_id: id, role: 'manager', launch_at: '2026-11-09' }); m.rpc.mockResolvedValue({ data: body }); });
it('rejects cross-origin, unauthenticated and staff policy changes before writing', async () => {
    expect((await POST(request(body, 'https://other.test'))).status).toBe(403);
    m.session.mockResolvedValue(null); expect((await POST(request())).status).toBe(401);
    m.session.mockResolvedValue({ user: { id } }); m.scope.mockResolvedValue({ user_id: id, role: 'member', launch_at: '2026-11-09' }); expect((await POST(request())).status).toBe(403); expect(m.rpc).not.toHaveBeenCalled();
});
it('binds settings to the supervisor and enforces limits', async () => {
    expect((await POST(request({ ...body, capacity_multiplier: 10 }))).status).toBe(400); expect(m.rpc).not.toHaveBeenCalled();
    expect((await POST(request({ ...body, actor_id: 'forged' }))).status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith('veo_quota_policy', { p_actor: id, p_worker: id, p_data: { carry_enabled: true, max_carry: 10, capacity_multiplier: 2, fallback_cpa_minor: 10000 } });
});
it('uses the branch-authorized policy read without changing a quota', async () => {
    const r = await GET(new NextRequest('https://veo.test/api/workspace/quota-policy?worker_id=' + id)); expect(r.status).toBe(200); expect(r.headers.get('cache-control')).toBe('no-store'); expect(m.rpc).toHaveBeenCalledWith('veo_quota_policy', { p_actor: id, p_worker: id, p_data: null });
});
