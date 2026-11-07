import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), scope: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/veo-workspace', () => ({ workspaceScope: m.scope, uuid: (v: string) => /^[0-9a-f-]{36}$/.test(v || ''), philippineDate: (d = new Date()) => new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 10) }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => m }));
vi.mock('@/lib/meta-ads-credentials', () => ({ decryptMetaAdsToken: vi.fn() }));
vi.mock('@/lib/facebook-ad-catalog', () => ({ readMetaAds: vi.fn() }));
import { GET } from './route';
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
