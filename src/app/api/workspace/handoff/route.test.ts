import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), connected: vi.fn(), storage: { from: vi.fn() } }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => m }));
vi.mock('@/lib/veo-jaucian', () => ({ connectedVeoTenant: m.connected, veoDirectory: vi.fn() }));
import { GET, POST } from './route';
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
describe('temporary photo access for Jaucian', () => {
    it('authenticates workforce writes and verifies the connected tenant before accepting observations', async () => {
        vi.stubEnv('VEO_JAUCIAN_SECRET', 'test-key');
        const payload = { resource: 'workforce', tenant_id: '00000000-0000-4000-8000-000000000001', workers: [] };
        const request = (key: string) => new NextRequest('https://veo.test/api/workspace/handoff', { method: 'POST', headers: { Authorization: key, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        expect((await POST(request('Bearer wrong-key'))).status).toBe(401);
        expect(m.rpc).not.toHaveBeenCalled(); expect(m.connected).not.toHaveBeenCalled();
        m.connected.mockRejectedValueOnce(Object.assign(new Error('Tenant is not connected'), { status: 403 }));
        expect((await POST(request('Bearer test-key'))).status).toBe(403);
        expect(m.rpc).not.toHaveBeenCalled();
        m.connected.mockResolvedValue({}); m.rpc.mockResolvedValue({ data: { removed: 0 } });
        expect((await POST(request('Bearer test-key'))).status).toBe(200);
        expect(m.rpc).toHaveBeenCalledWith('veo_apply_telegram_observations', { p_tenant: payload.tenant_id, p_payload: payload });
    });
    it('never signs a photo for blocked, expired or deleted submissions even after eligibility is restored', async () => {
        vi.stubEnv('VEO_JAUCIAN_SECRET', 'test-key');
        m.rpc.mockResolvedValue({ data: { order_id: 'order' }, error: null });
        for (const state of [{ status: 'blocked' }, { status: 'expired' }, { status: 'delivered', deleted_at: new Date().toISOString() }]) {
            m.from.mockReturnValue({ select: () => ({ eq: () => ({ single: async () => ({ data: { object_path: 'private-photo', ...state }, error: null }) }) }) });
            const r = await GET(new NextRequest('https://veo.test/api/workspace/handoff?submission_id=00000000-0000-4000-8000-000000000001', { headers: { Authorization: 'Bearer test-key' } }));
            expect(r.status).toBe(state.status === 'delivered' ? 410 : 409);
        }
        expect(m.storage.from).not.toHaveBeenCalled();
    });
});
