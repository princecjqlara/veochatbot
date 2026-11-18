import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ admin: vi.fn(), delivered: vi.fn(), expiry: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: m.admin }));
vi.mock('@/lib/veo-delivered-photo-cleanup', () => ({ cleanupDeliveredReceiptPhotos: m.delivered }));
vi.mock('@/lib/veo-photo-cleanup', () => ({ cleanupWorkspacePhotos: m.expiry }));
import { GET } from './route';
const request = (authorized = true) => new NextRequest('https://veo.test/api/cron/receipt-photos', { headers: authorized ? { Authorization: 'Bearer cron' } : {} });
beforeEach(() => { vi.resetAllMocks();vi.stubEnv('CRON_SECRET', 'cron');vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true');m.admin.mockReturnValue({});m.delivered.mockResolvedValue({ removed: 3 });m.expiry.mockResolvedValue(undefined); });
afterEach(() => vi.unstubAllEnvs());
it('authenticates before accessing storage or SQL', async () => {
    expect((await GET(request(false))).status).toBe(401);expect(m.admin).not.toHaveBeenCalled();
});
it('independently sweeps delivered evidence and expired files without loading workforce or planning', async () => {
    const response = await GET(request());expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, delivered_photos_removed: 3, delivered_retry: false, expiry_retry: false });
    expect(m.delivered).toHaveBeenCalledOnce();expect(m.expiry).toHaveBeenCalledOnce();
});
it.each(['delivered', 'expiry'] as const)('reports a retry and continues the other phase after %s cleanup fails', async phase => {
    m[phase].mockRejectedValue(Error('Unavailable'));const response = await GET(request());
    expect(response.status).toBe(503);expect(await response.json()).toMatchObject({ ok: false, delivered_retry: phase === 'delivered', expiry_retry: phase === 'expiry' });
    expect(m.delivered).toHaveBeenCalledOnce();expect(m.expiry).toHaveBeenCalledOnce();
});
