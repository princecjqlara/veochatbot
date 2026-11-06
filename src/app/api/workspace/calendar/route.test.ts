import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), scope: vi.fn(), rpc: vi.fn(), build: vi.fn(), load: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/veo-workspace', () => ({ workspaceScope: m.scope, philippineDate: () => '2026-11-06', uuid: (v: string) => /^[\da-f-]{36}$/.test(v) }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => m }));
vi.mock('@/lib/veo-calendar-analytics', () => ({ buildVeoCalendar: m.build }));
vi.mock('@/lib/veo-calendar-loader', () => ({ loadVeoCalendarInputs: m.load }));
import { GET } from './route';
const page = '00000000-0000-4000-8000-000000000001';
beforeEach(() => { m.session.mockResolvedValue({ user: { id: 'owner' } }); m.scope.mockResolvedValue({ user_id: 'owner', role: 'owner', launch_at: '2026-11-05', page_ids: [page] }); m.rpc.mockResolvedValue({ data: { records: true } }); m.load.mockResolvedValue({ records: true }); m.build.mockReturnValue({ days: [], selected: { cohort: {} } }); });
afterEach(() => { vi.clearAllMocks(); });
it.each(['member', 'manager'])('denies %s calendar analytics before reading data', async role => {
    m.scope.mockResolvedValue({ user_id: 'worker', role, launch_at: '2026-11-05', page_ids: [page] });
    expect((await GET(new NextRequest('https://veo.test/api/workspace/calendar'))).status).toBe(403); expect(m.rpc).not.toHaveBeenCalled();
});
it('restores pre-launch historical reporting across all assigned Pages', async () => {
    const r = await GET(new NextRequest('https://veo.test/api/workspace/calendar?month=2020-01&day=2020-01-05'));
    expect(r.status).toBe(200); expect(r.headers.get('cache-control')).toBe('no-store');
    expect(m.load).toHaveBeenCalledWith(m, 'owner', [page], '2020-01-01', '2020-01-31', '2020-01-05');
    expect(m.rpc).not.toHaveBeenCalled();
});
it('keeps Team Leaders within their assigned Page and rejects dates outside the month', async () => {
    m.scope.mockResolvedValue({ user_id: 'leader', role: 'team_leader', launch_at: '2026-11-05', page_ids: [page] });
    expect((await GET(new NextRequest(`https://veo.test/api/workspace/calendar?page_id=${page}`))).status).toBe(200);
    m.rpc.mockClear();
    expect((await GET(new NextRequest(`https://veo.test/api/workspace/calendar?page_id=${page.replace(/1$/, '2')}`))).status).toBe(403);
    expect((await GET(new NextRequest('https://veo.test/api/workspace/calendar?month=2026-11&day=2026-10-01'))).status).toBe(400); expect(m.rpc).not.toHaveBeenCalled();
});
it('fails an incomplete data read rather than presenting it as empty calendar data', async () => {
    m.load.mockRejectedValue(Object.assign(new Error('Incomplete calendar slice'), { status: 503 }));
    const r = await GET(new NextRequest('https://veo.test/api/workspace/calendar'));
    expect(r.status).toBe(503); expect(m.build).not.toHaveBeenCalled();
});
