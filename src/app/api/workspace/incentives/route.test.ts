import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), scope: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/veo-workspace', async original => ({ ...await original<any>(), workspaceScope: m.scope }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ rpc: m.rpc }) }));
import { GET, POST } from './route';
const id = '00000000-0000-4000-8000-000000000001';
const body = { kind: 'review', id, percent: 5, reason: 'Excellent service', expected_version: 0, request_id: id, save_reason: true };
const request = (value: any = body, origin = 'https://veo.test') => new NextRequest('https://veo.test/api/workspace/incentives', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
beforeEach(() => { vi.resetAllMocks(); m.session.mockResolvedValue({ user: { id } }); m.scope.mockResolvedValue({ user_id: id, role: 'manager', launch_at: '2026-11-09' }); m.rpc.mockResolvedValue({ data: { incentive: { percent: 5 } } }); });
it('rejects unauthenticated, staff and cross-origin awards before writing', async () => {
    expect((await POST(request(body, 'https://other.test'))).status).toBe(403);
    m.session.mockResolvedValue(null); expect((await POST(request())).status).toBe(401);
    m.session.mockResolvedValue({ user: { id } }); m.scope.mockResolvedValue({ user_id: id, role: 'member', launch_at: '2026-11-09' }); expect((await POST(request())).status).toBe(403); expect(m.rpc).not.toHaveBeenCalled();
});
it('binds the award to the signed-in supervisor and passes version and retry identifiers', async () => {
    expect((await POST(request({ ...body, actor_id: 'forged' }))).status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith('veo_incentive_save', { p_actor: id, p_kind: 'review', p_id: id, p_percent: 5, p_reason: 'Excellent service', p_expected: 0, p_request: id, p_save_reason: true });
});
it('validates percentage and reads legacy receipt incentives without requiring reviewed-deal mode', async () => {
    expect((await POST(request({ ...body, percent: 61 }))).status).toBe(400); expect(m.rpc).not.toHaveBeenCalled();
    const response = await GET(new NextRequest('https://veo.test/api/workspace/incentives?kind=receipt&id=' + id)); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
});
