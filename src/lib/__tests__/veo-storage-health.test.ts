import { afterEach, expect, it, vi } from 'vitest';
import { parseStorageMetrics, readStorageMetrics, requireStorageForOptionalWork } from '../veo-storage-health';
const metrics = 'node_filesystem_size_bytes{mountpoint="/",device="root"} 1000\nnode_filesystem_avail_bytes{device="root",mountpoint="/"} 1\nnode_filesystem_size_bytes{device="data",mountpoint="/data"} 2e9\nnode_filesystem_avail_bytes{mountpoint="/data",device="data"} 1.5e9\npg_wal_size_mb{service_type="postgresql"} 64';
afterEach(() => { vi.unstubAllGlobals();vi.unstubAllEnvs(); });
it('uses the actual data disk, including reserved space, rather than database size or the OS volume', () => {
    expect(parseStorageMetrics(metrics)).toEqual({ available: true, disk_size_bytes: 2000000000, disk_available_bytes: 1500000000, wal_bytes: 67108864, resource_metrics_available: false });
    expect(() => parseStorageMetrics('node_filesystem_size_bytes{mountpoint="/"} 1000')).toThrow('unavailable');
    expect(() => parseStorageMetrics(metrics + '\nnode_filesystem_size_bytes{mountpoint="/data"} 3e9')).toThrow('Ambiguous');
});
it('never treats failed, empty or impossible metrics as a healthy disk', async () => {
    expect(() => parseStorageMetrics(metrics.replace('1.5e9', '3e9'))).toThrow('unavailable');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://mjuluaqrvbnycisnarzi.supabase.co');vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'private-metric-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    await expect(readStorageMetrics()).rejects.toThrow('temporarily unavailable');
});
it('sends metric credentials only to the configured project and bounds the read', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://mjuluaqrvbnycisnarzi.supabase.co');vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'private-metric-key');
    const fetcher = vi.fn(async (_url, _init) => new Response(metrics));vi.stubGlobal('fetch', fetcher);
    expect((await readStorageMetrics()).available).toBe(true);
    const [url, init] = fetcher.mock.calls[0];expect(url.hostname).toBe('mjuluaqrvbnycisnarzi.supabase.co');expect(url.toString()).not.toContain('private-metric-key');expect(init.signal).toBeInstanceOf(AbortSignal);
});
it('pauses optional growth on critical, stale, incomplete or unavailable health', async () => {
    for (const result of [{ error: { message: 'offline' } }, { data: {} }, { data: { optional_work_paused: true } }]) await expect(requireStorageForOptionalWork({ rpc: async () => result })).rejects.toMatchObject({ code: 'STORAGE_ATTENTION', status: 503 });
    expect(await requireStorageForOptionalWork({ rpc: async () => ({ data: { optional_work_paused: false } }) })).toEqual({ optional_work_paused: false });
});
