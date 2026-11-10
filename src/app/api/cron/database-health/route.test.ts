import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ metrics: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/veo-storage-health', () => ({ readStorageMetrics: m.metrics }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ rpc: m.rpc }) }));
import { GET } from './route';
const request = (auth = true) => new NextRequest('https://veo.test/api/cron/database-health', { headers: auth ? { Authorization: 'Bearer test' } : {} });
beforeEach(() => { vi.clearAllMocks();vi.stubEnv('CRON_SECRET', 'test');vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true');m.metrics.mockResolvedValue({ available: true }); });
afterEach(() => { vi.unstubAllEnvs(); });
it('authenticates before probing metrics or writing the bounded checkpoint', async () => {
    expect((await GET(request(false))).status).toBe(401);expect(m.metrics).not.toHaveBeenCalled();expect(m.rpc).not.toHaveBeenCalled();
});
it('reports healthy only when both disk metrics and independent cleanup are healthy', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'healthy', maintenance_healthy: true } });expect((await GET(request())).status).toBe(200);
    m.rpc.mockResolvedValueOnce({ data: { status: 'critical', maintenance_healthy: true } });expect((await GET(request())).status).toBe(503);
    m.rpc.mockResolvedValueOnce({ data: { status: 'healthy', maintenance_healthy: false } });expect((await GET(request())).status).toBe(503);
});
it('records failed monitoring and makes checkpoint failures visible', async () => {
    m.metrics.mockRejectedValueOnce(Error('offline'));m.rpc.mockResolvedValueOnce({ data: { status: 'unknown' } });expect((await GET(request())).status).toBe(503);
    expect(m.rpc).toHaveBeenCalledWith('veo_record_storage_metrics', { p_metrics: { available: false } });
    m.rpc.mockResolvedValueOnce({ error: { message: 'offline' } });expect((await GET(request())).status).toBe(503);
});
