import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ rpc: m.rpc }) }));
import { GET } from './route';
const request = () => new NextRequest('https://veo.test/api/workspace/storage-health');
beforeEach(() => { vi.clearAllMocks(); });
it('exposes storage measurements only to the active owner', async () => {
    m.session.mockResolvedValueOnce(null);expect((await GET(request())).status).toBe(401);
    m.session.mockResolvedValueOnce({ user: { id: 'worker', role: 'member' } });expect((await GET(request())).status).toBe(403);expect(m.rpc).not.toHaveBeenCalled();
    m.session.mockResolvedValueOnce({ user: { id: 'owner', role: 'owner' } });m.rpc.mockResolvedValueOnce({ data: { status: 'healthy' } });const response = await GET(request());expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store');expect(m.rpc).toHaveBeenCalledWith('veo_owner_storage_health', { p_actor: 'owner' });
});
it('does not report a healthy disk when the database is unavailable', async () => {
    m.session.mockResolvedValue({ user: { id: 'owner', role: 'owner' } });m.rpc.mockResolvedValueOnce({ error: { code: 'PGRST002' } });expect((await GET(request())).status).toBe(503);
});
