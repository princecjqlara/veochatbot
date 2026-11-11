import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), scope: vi.fn(), from: vi.fn(), rpc: vi.fn(), directory: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/veo-workspace', () => ({ workspaceScope: m.scope, philippineDate: () => '2026-11-08' }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => m }));
vi.mock('@/lib/veo-account-directory', async original => ({ ...await original<any>(), loadVeoAccountDirectory: m.directory }));
import { GET } from './route';
const request = (view = 'deals', params = '') => new NextRequest(`https://veo.test/api/workspace/context?view=${view}&date=2026-11-08${params}`);
beforeEach(() => { m.session.mockResolvedValue({ user: { id: 'worker' } });m.scope.mockResolvedValue({ user_id: 'worker', tenant_id: 'tenant', role: 'member', page_ids: [], worker_ids: ['worker'], launch_at: '2026-11-05T00:00:00Z' });m.rpc.mockResolvedValue({ data: {} });m.directory.mockResolvedValue([{ role: 'member', active: true, is_active: false }]); });
afterEach(() => { vi.clearAllMocks(); });
it('returns only permission context for a focused panel instead of running finance, orders, and capacity reports', async () => {
    const r = await GET(request('deals')), body = await r.json();
    expect(r.status).toBe(200);expect(body.scope.user_id).toBe('worker');expect(body).toMatchObject({ accounts: [], orders: [], salary: [], capacity: null });
    expect(m.rpc).not.toHaveBeenCalled();expect(m.from).not.toHaveBeenCalled();
});
it('loads only capacity and the current worker salary for the capacity screen', async () => {
    m.rpc.mockImplementation(async (name: string) => ({ data: name === 'veo_salary' ? { closed: 1 } : { teams: [] } }));
    const body = await (await GET(request('capacity'))).json();
    expect(m.rpc.mock.calls.map(([name]) => name).sort()).toEqual(['veo_salary', 'veo_team_capacity']);
    expect(body.salary).toEqual([{ closed: 1 }]);expect(body.teams).toEqual([]);
    expect(m.rpc).toHaveBeenCalledWith('veo_salary', { p_user: 'worker', p_day: '2026-11-08' });
    expect(body.capacity.workforce_readiness).toEqual({ workers: 1, enabled: 0, disabled: 1, unknown: 0 });
});
it('uses the PostgreSQL salary signature and keeps salary or directory outages visible', async () => {
    m.rpc.mockImplementation(async (name: string, args: any) => name === 'veo_salary' && args.p_user !== 'worker' ? { error: { code: 'PGRST202' } } : { data: { teams: [] } });
    expect((await GET(request('capacity'))).status).toBe(200);
    m.rpc.mockResolvedValue({ error: { code: 'PGRST202' } });expect((await GET(request('capacity'))).status).toBe(503);
    m.rpc.mockResolvedValue({ data: {} });m.directory.mockRejectedValue(Error('Unavailable'));expect((await GET(request('capacity'))).status).toBe(503);
});
