import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), scope: vi.fn(), rpc: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/veo-workspace', () => ({ workspaceScope: m.scope, uuid: (v: string) => /^[0-9a-f-]{36}$/.test(v || ''), philippineDate: (d = new Date()) => new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 10) }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => m }));
vi.mock('@/lib/meta-ads-credentials', () => ({ decryptMetaAdsToken: vi.fn() }));
vi.mock('@/lib/facebook-ad-catalog', () => ({ readMetaAds: vi.fn() }));
import { GET } from './route';
import { readMetaAds } from '@/lib/facebook-ad-catalog';
import { decryptMetaAdsToken } from '@/lib/meta-ads-credentials';
const page = '00000000-0000-4000-8000-000000000001';
beforeEach(() => { m.session.mockResolvedValue({ user: { id: 'owner' } }); m.scope.mockResolvedValue({ user_id: 'owner', role: 'owner', page_ids: [page], launch_at: '2026-11-05' }); m.rpc.mockResolvedValue({ data: { from: '2026-11-06', to: '2026-11-06', as_of: '2026-11-07T00:00:00Z', clients: [], ads: [], spend: [] } }); });
afterEach(() => { vi.clearAllMocks(); });
const get = (q = 'range=7&pageId=' + page) => GET(new NextRequest('https://veo.test/api/workspace/creatives?' + q));
it('requires authentication, executive role and an authorized Page', async () => {
    m.session.mockResolvedValue(null); expect((await get()).status).toBe(401); m.session.mockResolvedValue({ user: { id: 'worker' } });
    for (const role of ['member', 'manager']) { m.scope.mockResolvedValue({ role, page_ids: [page], launch_at: '2026-11-05' }); expect((await get()).status).toBe(403); }
    m.scope.mockResolvedValue({ role: 'owner', page_ids: [], launch_at: '2026-11-05' }); expect((await get()).status).toBe(400); expect(m.rpc).not.toHaveBeenCalled();
});
it('uses the signed-in actor and returns complete creative data without interpreting missing data as sales', async () => {
    const r = await get(); expect(r.status).toBe(200); expect((await r.json()).ads).toEqual([]); expect(r.headers.get('cache-control')).toBe('no-store');
    expect(m.rpc).toHaveBeenCalledWith('veo_creative_inputs', expect.objectContaining({ p_actor: 'owner', p_page: page, p_ad: null }));
});
it('denies revoked access immediately and reports unavailable reads without partial figures', async () => {
    m.rpc.mockResolvedValue({ error: { code: '42501' } }); expect((await get()).status).toBe(403); expect(m.rpc).toHaveBeenCalledTimes(1);
    m.rpc.mockResolvedValue({ error: { code: 'OTHER' } }); expect((await get()).status).toBe(503);
});
function withCredential(expires: string | null = null) {
    m.rpc.mockResolvedValue({ data: { from: '2026-11-06', to: '2026-11-06', as_of: '2026-11-07T00:00:00Z', clients: [], ads: [{ ad_id: '1' }], spend: [] } });
    m.from.mockImplementation((table: string) => ({ select: () => ({ eq: () => ({
        single: async () => ({ data: { owner_id: 'owner' } }),
        maybeSingle: async () => ({ data: table === 'meta_ads_credentials' ? { token_ciphertext: 'encrypted', token_expires_at: expires } : null })
    }) }) }));
    vi.mocked(decryptMetaAdsToken).mockReturnValue('read-token');
}
it('fetches range unique reach and frequency for the default displayed ad as well as explicit selections', async () => {
    withCredential(); vi.mocked(readMetaAds).mockResolvedValue({ data: [{ ad_id: '1', reach: '100', frequency: '2.5', impressions: '250' }] });
    const body = await (await get()).json();
    expect(body.daily_ad_id).toBe('1'); expect(body.exact_delivery).toMatchObject({ ad_id: '1', reach: 100, frequency: 2.5, impressions: 250 });
    expect(body.exact_frequency.value).toBe(2.5); expect(body.ads[0].reach).toBeNull();
    expect(readMetaAds).toHaveBeenCalledWith('1/insights', 'read-token', expect.objectContaining({ fields: 'ad_id,frequency,reach,impressions' }));
});
it('keeps absent frequency unavailable and rejects mismatched or invalid range delivery evidence', async () => {
    withCredential(); vi.mocked(readMetaAds).mockResolvedValue({ data: [{ ad_id: '1', frequency: '', reach: '0', impressions: null }] });
    const body = await (await get()).json(); expect(body.exact_frequency).toBeNull(); expect(body.exact_delivery).toMatchObject({ reach: 0, frequency: null, impressions: null });
    for (const row of [{ ad_id: 'other', reach: '10', frequency: '1' }, { ad_id: '1', reach: '-10', frequency: true }]) {
        vi.mocked(readMetaAds).mockResolvedValue({ data: [row] }); const invalid = await (await get()).json(); expect(invalid.exact_delivery).toBeNull(); expect(invalid.exact_frequency).toBeNull();
    }
});
it('preserves saved reporting when range Insights fails or the ad credential has expired', async () => {
    withCredential(); vi.mocked(readMetaAds).mockRejectedValue(Error('Rate limited'));
    const body = await (await get()).json(); expect(body.ads).toHaveLength(1); expect(body.exact_delivery).toBeNull();
    vi.mocked(readMetaAds).mockClear(); withCredential('2020-01-01T00:00:00Z'); expect((await get()).status).toBe(200); expect(readMetaAds).not.toHaveBeenCalled();
});
