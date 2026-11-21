import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ metrics: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/veo-storage-health', () => ({ readStorageMetrics: m.metrics }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ rpc: m.rpc }) }));
import { GET } from './route';
const request = (auth = true) => new NextRequest('https://veo.test/api/cron/database-health', { headers: auth ? { Authorization: 'Bearer test' } : {} });
beforeEach(() => {
    vi.resetAllMocks();vi.stubEnv('CRON_SECRET', 'test');vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true');
    m.metrics.mockResolvedValue({ available: true });
    m.rpc.mockImplementation(async name => ({ data: name === 'veo_maintenance_phase_status' ? { healthy: true, phases: [] }
        : { status: 'healthy', maintenance_healthy: true, resource_metrics_fresh: true, resource_pressure: false } }));
});
afterEach(() => { vi.unstubAllEnvs();vi.restoreAllMocks(); });
it('authenticates before probing metrics or writing the bounded checkpoint', async () => {
    expect((await GET(request(false))).status).toBe(401);expect(m.metrics).not.toHaveBeenCalled();expect(m.rpc).not.toHaveBeenCalled();
});
it('reports healthy only when both disk metrics and independent cleanup are healthy', async () => {
    expect((await GET(request())).status).toBe(200);
    m.rpc.mockResolvedValueOnce({ data: { status: 'critical', maintenance_healthy: true } });expect((await GET(request())).status).toBe(503);
    m.rpc.mockResolvedValueOnce({ data: { status: 'healthy', maintenance_healthy: false } });expect((await GET(request())).status).toBe(503);
});
it('records failed monitoring and makes checkpoint failures visible', async () => {
    m.metrics.mockRejectedValueOnce(Error('offline'));m.rpc.mockResolvedValueOnce({ data: { status: 'unknown' } });expect((await GET(request())).status).toBe(503);
    expect(m.rpc).toHaveBeenCalledWith('veo_record_storage_metrics', { p_metrics: { available: false } });
    m.rpc.mockResolvedValueOnce({ error: { message: 'offline' } });expect((await GET(request())).status).toBe(503);
});
it('reports pressure or missing resource measurements despite healthy disk space', async () => {
    for (const resource of [{ resource_metrics_fresh: true, resource_pressure: true }, { resource_metrics_fresh: false, resource_pressure: false }, {}]) {
        m.rpc.mockResolvedValueOnce({ data: { status: 'healthy', maintenance_healthy: true, ...resource } });
        expect((await GET(request())).status).toBe(503);
    }
});
it('keeps phase failures and unavailable phase monitoring unhealthy even with healthy host metrics', async () => {
    vi.spyOn(console,'warn').mockImplementation(() => {});
    for (const result of [{ data: { healthy: true, phases: [] } }, { data: { healthy: false, phases: [] } }, { error: { code: '57014' } }]) {
        m.rpc.mockResolvedValueOnce({ data: { status: 'healthy', maintenance_healthy: true, resource_metrics_fresh: true, resource_pressure: false } }).mockResolvedValueOnce(result);
        const response = await GET(request());
        const expectedHealthy = result.data?.healthy === true;
        expect(response.status).toBe(expectedHealthy ? 200 : 503);
        const body = await response.json();expect(body.maintenance_phases_healthy).toBe(expectedHealthy);
    }
});
