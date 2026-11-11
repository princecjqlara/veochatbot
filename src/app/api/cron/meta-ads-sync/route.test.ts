import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ refresh: vi.fn(), ids: vi.fn(), db: vi.fn(), decrypt: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: m.db }));
vi.mock('@/lib/page-access', () => ({ getUserPageIds: m.ids }));
vi.mock('@/lib/veo-stored-ads-refresh', () => ({ refreshStoredWorkspaceAds: m.refresh }));
vi.mock('@/lib/meta-ads-credentials', () => ({ decryptMetaAdsToken: m.decrypt }));
vi.mock('@/lib/veo-workspace', () => ({ workspaceEnabled: () => true }));
import { GET } from './route';
let pageQuery: any;
beforeEach(() => {
    vi.resetAllMocks(); vi.stubEnv('CRON_SECRET', 'test-only');
    m.ids.mockResolvedValue(['veo']); m.decrypt.mockReturnValue('test-token'); m.refresh.mockResolvedValue({ complete: true, errors: [] });
    pageQuery = { in: vi.fn(() => pageQuery), eq: vi.fn(() => Promise.resolve({ data: [{ id: 'veo', fb_page_id: '111' }] })) };
    m.db.mockReturnValue({ from: (table: string) => table === 'meta_ads_credentials' ? { select: () => ({ limit: async () => ({ data: [{ user_id: 'owner' }] }) }), update: () => ({ eq: async () => ({ error: null }) }) } : { select: () => pageQuery } });
});
afterEach(() => { vi.unstubAllEnvs(); });
const request = (authorized = true) => new NextRequest('https://veo.test/api/cron/meta-ads-sync', { headers: authorized ? { Authorization: 'Bearer test-only' } : {} });
it('authenticates before any credential read', async () => { expect((await GET(request(false))).status).toBe(401); expect(m.db).not.toHaveBeenCalled(); });
it('uses current Page scope, excludes disabled Pages and refreshes the newest dates every run', async () => {
    expect((await GET(request())).status).toBe(200);
    const options = m.refresh.mock.calls[0][0]; expect(options).toMatchObject({ user: 'owner', workspaceOnly: true });
    expect(Date.parse(options.to) - Date.parse(options.from)).toBe(3 * 86400000);
    expect(await options.authorize()).toEqual(['veo']);
});
it('does not overwrite connection health when a manual refresh owns the lease',async()=>{
    m.refresh.mockRejectedValue(Object.assign(Error('Refresh already running'),{status:409}));
    const response=await GET(request());expect(response.status).toBe(200);expect((await response.json()).reports[0].skipped).toBe(true);
});
it('reports a failed source fetch instead of declaring successful synchronization', async () => {
    m.refresh.mockResolvedValue({ complete: false, errors: ['Incomplete account report'] });
    const r = await GET(request()); expect(r.status).toBe(503); expect((await r.json()).complete).toBe(false);
});
