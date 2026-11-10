import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ owner: vi.fn(), rows: [] as any[], range: vi.fn(), graph: vi.fn(), health: vi.fn(), grant: vi.fn(), filters: [] as any[] }));
vi.mock('@/lib/veo-page-connections', async () => ({ ...await vi.importActual<any>('@/lib/veo-page-connections'), requirePageOwner: m.owner }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ from: () => {
    const q: any = { select: () => q, eq: (key: any, value: any) => { m.filters.push([key, value]); return q; }, order: () => q, abortSignal: () => q, range: m.range }; return q;
} }) }));
vi.mock('@/lib/facebook-page-authorization', () => ({ readFacebookPageGrant: m.grant, pageAuthorizationConfigured: () => true, pageCallbackUrl: () => 'https://veo.test/api/auth/callback/facebook', pageGraph: m.graph }));
vi.mock('@/lib/facebook-page-connection', () => ({ facebookWebhookConnectionStatus: m.health }));
import { GET } from './route';
import { pageConnectionCache } from '@/lib/page-connection-cache';
const get = () => GET(new NextRequest('https://veo.test/api/workspace/pages?refresh=1'));
beforeEach(() => {
    vi.clearAllMocks(); pageConnectionCache.clear(); m.filters = []; vi.stubEnv('FACEBOOK_CLIENT_ID', 'app'); vi.stubEnv('VEO_ENFORCE_PAGE_RUNTIME_SCOPE', 'true');
    m.owner.mockResolvedValue({ user_id: 'owner', role: 'owner', tenant_id: 'tenant', launch_at: '2026-11-01' }); m.grant.mockResolvedValue(null);
    m.range.mockImplementation(async (from: number, to: number) => ({ data: m.rows.slice(from, to + 1) }));
    m.graph.mockImplementation(async (_path: string, token: string) => ({ id: token.slice(6) })); m.health.mockResolvedValue('ready');
    m.rows = [{ id: 'one', fb_page_id: '123', name: 'Saved Page', access_token: 'token-123', veo_enabled: true, automation_app_id: 'app' }];
});
afterEach(() => { vi.unstubAllEnvs(); });
it('paginates all saved Pages in the Owner tenant without serializing credentials', async () => {
    m.rows = Array.from({ length: 1001 }, (_, index) => ({ ...m.rows[0], id: 'page-' + index, fb_page_id: String(index), access_token: 'token-' + index }));
    const response = await get(), body = await response.json(); expect(response.status).toBe(200); expect(body.pages).toHaveLength(1001);
    expect(m.range).toHaveBeenCalledTimes(2); expect(m.filters).toContainEqual(['veo_tenant_id', 'tenant']);
    expect(body.pages.at(-1).facebookPageId).toBe('1000'); expect(JSON.stringify(body)).not.toContain('token-');
});
it('keeps disabled and unverified Pages visible and never labels unknown health as Connected', async () => {
    m.rows.push({ ...m.rows[0], id: 'two', veo_enabled: false }); m.graph.mockRejectedValue(new Error('offline'));
    const body = await (await get()).json(); expect(body.pages.map((page: any) => page.status)).toEqual(['unknown', 'disabled']);
});
it('surfaces a failed later database page instead of returning a successful truncated directory', async () => {
    m.rows = Array.from({ length: 1000 }, () => m.rows[0]); m.range.mockResolvedValueOnce({ data: m.rows }).mockResolvedValueOnce({ error: { message: 'source unavailable' } });
    const response = await get(); expect(response.status).toBe(503); expect((await response.json()).pages).toBeUndefined();
});
it('requires Owner scope before listing records or checking Facebook', async () => {
    m.owner.mockRejectedValue(Object.assign(new Error('Owner required'), { status: 403 }));
    expect((await get()).status).toBe(403); expect(m.range).not.toHaveBeenCalled(); expect(m.graph).not.toHaveBeenCalled();
});
