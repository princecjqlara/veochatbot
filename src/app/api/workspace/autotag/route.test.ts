import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), scope: vi.fn(), read: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/veo-workspace', () => ({ workspaceScope: m.scope }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({}) }));
vi.mock('@/lib/veo-report-read', () => ({ readVeoRpc: m.read }));
import { GET } from './route';
const request = () => new NextRequest('https://veo.test/api/workspace/autotag');
beforeEach(() => { m.session.mockResolvedValue({ user: { id: 'owner' } });m.scope.mockResolvedValue({ user_id: 'owner', role: 'owner', launch_at: '2026-11-09' });m.read.mockResolvedValue({ data: { pages: [] } }); });
afterEach(() => { vi.resetAllMocks(); });
it('requires current supervisor access and uses the signed-in actor for Page-scoped status', async () => {
    m.session.mockResolvedValue(null);expect((await GET(request())).status).toBe(401);
    m.session.mockResolvedValue({ user: { id: 'owner' } });
    for (const role of ['member', 'manager']) { m.scope.mockResolvedValue({ role, launch_at: '2026-11-09' });expect((await GET(request())).status).toBe(403); }
    expect(m.read).not.toHaveBeenCalled();
    m.scope.mockResolvedValue({ user_id: 'owner', role: 'team_leader', launch_at: '2026-11-09' });const response = await GET(request());expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');expect(m.read).toHaveBeenCalledWith({}, 'veo_autotag_status', { p_actor: 'owner' });
});
it('does not expose an unavailable database or certify failed reads as an empty successful scan', async () => {
    m.read.mockResolvedValue({ error: { message: 'private-db-details' } });const response = await GET(request());expect(response.status).toBe(503);expect(JSON.stringify(await response.json())).not.toContain('private-db-details');
});
