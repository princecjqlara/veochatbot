import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() } }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => m }));
import { GET } from './route';
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
describe('temporary photo access for Jaucian', () => {
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
