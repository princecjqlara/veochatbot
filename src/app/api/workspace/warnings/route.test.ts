import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), scope: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/veo-workspace', async () => ({ ...await vi.importActual<any>('@/lib/veo-workspace'), workspaceScope: m.scope }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ rpc: m.rpc }) }));
import { GET, POST } from './route';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const request = (body: any, origin = 'https://veo.test') => new NextRequest('https://veo.test/api/workspace/warnings', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const suspend = () => ({ action: 'suspend', user_id: id(2), request_id: id(3), duration_minutes: null, reason: 'Review this member’s conduct' });
beforeEach(() => { m.session.mockResolvedValue({ user: { id: id(1) } });m.scope.mockResolvedValue({ user_id: id(1), role: 'manager', launch_at: '2026-11-05' });m.rpc.mockResolvedValue({ data: {} }); });
afterEach(() => { vi.resetAllMocks(); });
it.each(['manager', 'team_leader', 'owner'])('uses the stored %s actor and strips forged role and tenant fields', async role => {
    m.scope.mockResolvedValue({ user_id: id(1), role, launch_at: '2026-11-05' });
    expect((await POST(request({ ...suspend(), actor_id: id(8), role: 'owner', tenant_id: id(9) }))).status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith('veo_discipline_action', { p_actor: id(1), p_action: 'suspend', p_data: { user_id: id(2), request_id: id(3), duration_minutes: null, reason: 'Review this member’s conduct' } });
});
it('rejects cross-origin, anonymous and member mutations before touching warning records', async () => {
    expect((await POST(request(suspend(), 'https://other.test'))).status).toBe(403);
    m.session.mockResolvedValueOnce(null);expect((await POST(request(suspend()))).status).toBe(401);
    m.scope.mockResolvedValue({ user_id: id(1), role: 'member', launch_at: '2026-11-05' });
    expect((await POST(request({ ...suspend(), role: 'manager' }))).status).toBe(403);expect(m.rpc).not.toHaveBeenCalled();
});
it('validates warning limits and explicit timed or manual duration choices', async () => {
    for (const duration_minutes of [-1, 0, 1.5, 525601, undefined, '60']) expect((await POST(request({ ...suspend(), duration_minutes }))).status).toBe(400);
    for (const warning_limit of [0, 101, 1.5]) expect((await POST(request({ action: 'policy', warning_limit, auto_suspend: true, suspension_minutes: null }))).status).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
    expect((await POST(request({ action: 'policy', warning_limit: 3, auto_suspend: true, suspension_minutes: 1440 }))).status).toBe(200);
    expect((await POST(request({ ...suspend(), duration_minutes: 60 }))).status).toBe(200);
});
it('requires a selected warning and current suspension for removal and lifting', async () => {
    expect((await POST(request({ action: 'remove', user_id: id(2), reason: 'Excused absence' }))).status).toBe(400);
    expect((await POST(request({ action: 'lift', user_id: id(2), reason: 'Review completed' }))).status).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
    expect((await POST(request({ action: 'remove', user_id: id(2), source_key: 'overdue:order', reason: 'Excused absence' }))).status).toBe(200);
    expect((await POST(request({ action: 'lift', user_id: id(2), suspension_id: id(4), reason: 'Review completed' }))).status).toBe(200);
});
it('preserves branch denials and uncertain-save errors instead of declaring success', async () => {
    m.rpc.mockResolvedValueOnce({ error: { code: '42501', message: 'Choose a member in your branch' } });
    expect((await POST(request(suspend()))).status).toBe(403);
    m.rpc.mockResolvedValueOnce({ error: { message: 'The connection to the database timed out' } });
    const response = await POST(request(suspend()));expect(response.status).toBe(503);expect((await response.json()).error).toContain('could not be confirmed');
});
it.each(['PT409', '23505', '40001'])('returns a %s conflict once without replaying the suspension change', async code => {
    m.rpc.mockResolvedValue({ error: { code, message: 'Suspension changed. Refresh this member.' } });
    const response = await POST(request(suspend()));
    expect(response.status).toBe(409);expect((await response.json()).error).toContain('Refresh this member');
    expect(m.rpc).toHaveBeenCalledTimes(1);
});
it('still allows authenticated scoped warning reads and never exposes management actions to members', async () => {
    m.scope.mockResolvedValue({ user_id: id(1), role: 'member', launch_at: '2026-11-05' });
    m.rpc.mockResolvedValue({ data: { workers: [], can_manage_discipline: false } });
    const response = await GET(new NextRequest('https://veo.test/api/workspace/warnings'));
    expect(response.status).toBe(200);expect((await response.json()).can_manage_discipline).toBe(false);
    expect(m.rpc).toHaveBeenCalledWith('veo_workflow_warnings', { p_actor: id(1), p_worker: null });
});
