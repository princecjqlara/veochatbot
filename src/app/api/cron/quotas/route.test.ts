import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ rpc: vi.fn(), guard: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => m }));
vi.mock('@/lib/veo-storage-health', () => ({ requireStorageForOptionalWork: m.guard }));
import { GET } from './route';
const request = () => new NextRequest('https://veo.test/api/cron/quotas', { headers: { Authorization: 'Bearer cron' } });
beforeEach(() => { vi.stubEnv('CRON_SECRET', 'cron');vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true');m.guard.mockReset().mockResolvedValue({});m.rpc.mockReset().mockImplementation(async name=>({data:name==='veo_claim_quota_refresh'?[]:true})); });
afterEach(() => { vi.unstubAllEnvs(); });
it('defers quota recalculation during resource pressure without changing saved quotas', async () => {
    m.guard.mockRejectedValue(Error('Database pressure'));
    const response = await GET(request());
    expect(response.status).toBe(503);expect(await response.json()).toMatchObject({ skipped: true, retryable: true });expect(m.rpc).not.toHaveBeenCalled();
});
it('resumes recalculation after the resource guard permits it', async () => {
    expect((await GET(request())).status).toBe(200);expect(m.rpc).toHaveBeenCalledWith('veo_claim_quota_refresh',{p_limit:4});
    expect(m.rpc.mock.calls.some(([name])=>name==='veo_refresh_spend_quotas')).toBe(false);
});
it('reports refresh transport failures as retryable service failures', async () => {
    m.rpc.mockRejectedValue(Error('Supabase request timed out'));
    expect((await GET(request())).status).toBe(503);expect(m.rpc).toHaveBeenCalledOnce();
});
it('authenticates before monitoring or recalculating', async () => {
    expect((await GET(new NextRequest('https://veo.test/api/cron/quotas'))).status).toBe(401);expect(m.guard).not.toHaveBeenCalled();expect(m.rpc).not.toHaveBeenCalled();
});
