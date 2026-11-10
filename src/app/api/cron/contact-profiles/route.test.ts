import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ legacy: vi.fn(), demographics: vi.fn(), storage: vi.fn() }));
vi.mock('@/lib/background-run', () => ({ runBackgroundJob: async (_name: string, operation: () => Promise<any>) => operation() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({}) }));
vi.mock('@/lib/veo-storage-health', () => ({ requireStorageForOptionalWork: m.storage }));
vi.mock('@/lib/contact-profile-worker', () => ({ processContactProfiles: m.legacy }));
vi.mock('@/lib/veo-demographics-worker', () => ({ processVeoDemographics: m.demographics }));
import { GET } from './route';
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
const request = (authorized = true) => new NextRequest('https://veo.test/api/cron/contact-profiles', { headers: authorized ? { Authorization: 'Bearer test' } : {} });
it('authenticates before running AI extraction', async () => { vi.stubEnv('CRON_SECRET', 'test'); expect((await GET(request(false))).status).toBe(401); expect(m.demographics).not.toHaveBeenCalled(); });
it('uses saved-source demographics without restarting full historical profile imports', async () => {
    vi.stubEnv('CRON_SECRET', 'test'); vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true'); m.demographics.mockResolvedValue({ processed: 2, failed: 0 });
    expect((await GET(request())).status).toBe(200); expect(m.demographics).toHaveBeenCalledWith(2); expect(m.legacy).not.toHaveBeenCalled();
});
it('reports extraction failures for scheduler retry instead of hiding them', async () => {
    vi.stubEnv('CRON_SECRET', 'test'); vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true'); m.demographics.mockResolvedValue({ processed: 1, failed: 1 });
    expect((await GET(request())).status).toBe(503);
});
it('does not start optional extraction when storage protection pauses it', async () => {
    vi.stubEnv('CRON_SECRET', 'test');vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true');m.storage.mockRejectedValueOnce(Error('Storage attention'));
    expect((await GET(request())).status).toBe(503);expect(m.demographics).not.toHaveBeenCalled();
});
