import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), scope: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/veo-workspace', () => ({ workspaceScope: m.scope, philippineDate: (value?: Date) => value ? value.toISOString().slice(0, 10) : '2026-11-06', uuid: (s: string) => /^[0-9a-f-]{36}$/.test(s) }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => m }));
import { GET } from './route';
const page = '00000000-0000-4000-8000-000000000001', worker = '00000000-0000-4000-8000-000000000003';
beforeEach(() => { m.session.mockResolvedValue({ user: { id: worker } }); m.scope.mockResolvedValue({ user_id: worker, role: 'member', launch_at: '2026-11-05', page_ids: [page] }); m.rpc.mockResolvedValue({ data: { verified: true } }); });
afterEach(() => { vi.clearAllMocks(); });
describe('role-protected performance and actual-salary calendar', () => {
    it.each(['owner', 'team_leader', 'manager'])('reads inclusive salary dates with the authenticated %s scope', async role => {
        m.scope.mockResolvedValue({ user_id: worker, role, launch_at: '2026-11-01', page_ids: [page] });
        expect((await GET(new NextRequest(`https://veo.test/api/workspace/operations?from=2026-11-02&to=2026-11-05&worker_id=${page}`))).status).toBe(200);
        expect(m.rpc).toHaveBeenCalledWith('veo_operations', expect.objectContaining({ p_actor: worker, p_from: '2026-11-02', p_to: '2026-11-05', p_worker: page }));
    });
    it.each(['from=2026-11-06&to=2026-11-05', 'from=2026-11-05&to=2026-11-07', 'from=2026-11-04&to=2026-11-06'])('rejects out-of-range dates %s before reading salary data', async query => {
        expect((await GET(new NextRequest('https://veo.test/api/workspace/operations?' + query))).status).toBe(400); expect(m.rpc).not.toHaveBeenCalled();
    });
    it.each(['member', 'manager'])('denies the calendar to %s on the server', async role => {
        m.scope.mockResolvedValue({ user_id: worker, role, launch_at: '2026-11-05', page_ids: [page] });
        expect((await GET(new NextRequest('https://veo.test/api/workspace/operations?view=calendar'))).status).toBe(403);
        expect(m.rpc).not.toHaveBeenCalled();
    });
    it('allows a Team Leader calendar only for their own assigned Pages', async () => {
        m.scope.mockResolvedValue({ user_id: worker, role: 'team_leader', launch_at: '2026-11-05', page_ids: [page] });
        expect((await GET(new NextRequest(`https://veo.test/api/workspace/operations?view=calendar&month=2026-11&page_id=${page}`))).status).toBe(200);
        expect(m.rpc).toHaveBeenCalledWith('veo_calendar_finance', { p_actor: worker, p_from: '2026-11-01', p_to: '2026-11-30', p_page: page });
        m.rpc.mockClear();
        expect((await GET(new NextRequest(`https://veo.test/api/workspace/operations?view=calendar&page_id=${page.replace(/1$/, '2')}`))).status).toBe(403);
        expect(m.rpc).not.toHaveBeenCalled();
    });
    it('forces a Member salary query to self even if another worker is requested', async () => {
        expect((await GET(new NextRequest(`https://veo.test/api/workspace/operations?from=2026-11-05&to=2026-11-06&worker_id=${page}`))).status).toBe(200);
        expect(m.rpc).toHaveBeenCalledWith('veo_operations', expect.objectContaining({ p_worker: worker, p_from: '2026-11-05', p_to: '2026-11-06' }));
    });
    it('permits the shared released-client pool while keeping branch enforcement in SQL', async () => {
        await GET(new NextRequest('https://veo.test/api/workspace/operations?status=released'));
        expect(m.rpc).toHaveBeenCalledWith('veo_operations', expect.objectContaining({ p_actor: worker, p_worker: null, p_status: 'released' }));
    });
    it('rejects invalid dates and preserves SQL branch-denial status', async () => {
        expect((await GET(new NextRequest('https://veo.test/api/workspace/operations?from=2026-02-30'))).status).toBe(400);
        expect(m.rpc).not.toHaveBeenCalled();
        m.rpc.mockResolvedValue({ error: { code: '42501', message: 'Forbidden' } });
        expect((await GET(new NextRequest('https://veo.test/api/workspace/operations'))).status).toBe(403);
    });
});
