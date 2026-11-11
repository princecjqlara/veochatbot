import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), scope: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/veo-workspace', () => ({ workspaceScope: m.scope, philippineDate: (date?: Date) => date ? new Date(date.getTime() + 8 * 3600000).toISOString().slice(0,10) : '2026-11-07', uuid: (v: string) => /^[0-9a-f-]{36}$/.test(v) }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => m }));
import { GET } from './route';
const owner = '00000000-0000-4000-8000-000000000001', worker = '00000000-0000-4000-8000-000000000002', page = '00000000-0000-4000-8000-000000000003';
const request = (q = '') => GET(new NextRequest('https://veo.test/api/workspace/employee-profile?' + q));
beforeEach(() => {
    m.session.mockResolvedValue({ user: { id: owner } }); m.scope.mockResolvedValue({ user_id: owner, role: 'owner', launch_at: '2026-11-05', page_ids: [page] });
    m.rpc.mockResolvedValue({ data: { employee: { id: worker }, summary: {}, capacity: {}, days: [], as_of: '2026-11-07T01:00:00Z', from: '2026-11-05', to: '2026-11-07' } });
});
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
it('requires authentication and active workspace access', async () => {
    m.session.mockResolvedValue(null); expect((await request()).status).toBe(401);
    m.session.mockResolvedValue({ user: { id: owner } }); m.scope.mockResolvedValue(null); expect((await request()).status).toBe(403); expect(m.rpc).not.toHaveBeenCalled();
});
it('requires valid employee, real dates and a bounded history range', async () => {
    for (const q of ['', `worker_id=${worker}&from=2026-02-30`, `worker_id=${worker}&from=2026-11-07&to=2026-11-06`, `worker_id=${worker}&from=2026-01-01&to=2026-11-07`, `worker_id=${worker}&from=2026-11-04&to=2026-11-07`, `worker_id=${worker}&from=2026-11-07&to=2026-11-08`]) expect((await request(q)).status).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
});
it('enforces member self and Page grants before calling the private RPC', async () => {
    m.scope.mockResolvedValue({ user_id: worker, role: 'member', launch_at: '2026-11-05', page_ids: [page] });
    expect((await request(`worker_id=${owner}`)).status).toBe(403);
    expect((await request('page_id=' + owner)).status).toBe(403); expect(m.rpc).not.toHaveBeenCalled();
    const r = await request(); expect(r.status).toBe(200); expect(r.headers.get('cache-control')).toBe('no-store');
    expect(m.rpc).toHaveBeenCalledWith('veo_employee_profile', expect.objectContaining({ p_actor: worker, p_worker: worker }));
});
it.each(['owner', 'team_leader', 'manager'])('delegates %s branch validation to SQL with the authenticated actor', async role => {
    m.scope.mockResolvedValue({ user_id: owner, role, launch_at: '2026-11-05', page_ids: [page] });
    expect((await request(`worker_id=${worker}&from=2026-11-05&to=2026-11-07&page_id=${page}`)).status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith('veo_employee_profile', { p_actor: owner, p_worker: worker, p_from: '2026-11-05', p_to: '2026-11-07', p_page: page });
    m.rpc.mockResolvedValue({ error: { code: '42501', message: 'Employee access denied' } });
    expect((await request(`worker_id=${worker}`)).status).toBe(403);
});
it('surfaces unavailable data instead of reporting a successful empty profile', async () => {
    m.rpc.mockResolvedValue({ data: null }); expect((await request(`worker_id=${worker}`)).status).toBe(400);
});
it('returns performance analytics with salary history and omits duplicate internal report inputs',async()=>{
    m.rpc.mockResolvedValue({data:{employee:{id:worker},summary:{},capacity:{},days:[{work_date:'2026-11-06',closed:1,done:1,totals:[]}],as_of:'2026-11-07T01:00:00Z',from:'2026-11-06',to:'2026-11-06',performance_inputs:{version:1,current_clients:3,ever_assigned_clients:4,new_clients:[{work_date:'2026-11-06',new_clients:2}]}}});
    const response=await request(`worker_id=${worker}&from=2026-11-06&to=2026-11-06`),body=await response.json();
    expect(response.status).toBe(200);expect(body.performance).toMatchObject({completed_days:1,current_clients:3,new_clients:2,average_done:1});
    expect(body.days).toHaveLength(1);expect(body.performance_inputs).toBeUndefined();
});
it('recovers a transient database timeout with the same authenticated filters', async () => {
    vi.useFakeTimers(); m.rpc.mockResolvedValueOnce({ error: { code: '57014' } });
    const response = request(`worker_id=${worker}`); await vi.advanceTimersByTimeAsync(500);
    expect((await response).status).toBe(200); expect(m.rpc).toHaveBeenCalledTimes(2);
    expect(m.rpc.mock.calls[0]).toEqual(m.rpc.mock.calls[1]);
});
it('returns service unavailable after bounded persistent timeouts', async () => {
    vi.useFakeTimers(); m.rpc.mockResolvedValue({ error: { code: '57014' } });
    const response = request(`worker_id=${worker}`); await vi.advanceTimersByTimeAsync(2000);
    expect((await response).status).toBe(503); expect(m.rpc).toHaveBeenCalledTimes(3);
});
