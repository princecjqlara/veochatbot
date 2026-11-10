import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), scope: vi.fn(), rpc: vi.fn(), existing: null as any, stored: null as any, legacy: null as any, verify: vi.fn(), app: vi.fn(), subscription: vi.fn(), health: vi.fn(), grant: vi.fn(), graph: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/veo-workspace', async () => ({ ...await vi.importActual<any>('@/lib/veo-workspace'), workspaceScope: m.scope }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ rpc: m.rpc, from: (table: string) => {
    const filters: Record<string, string> = {}; const q: any = { select: () => q, eq: (key: string, value: string) => { filters[key] = value; return q; }, maybeSingle: async () => ({ data: table === 'user_pages' ? m.legacy : filters.fb_page_id ? m.existing : m.stored }) }; return q;
} }) }));
vi.mock('@/lib/facebook', () => ({ subscribePageToAppWebhook: m.subscription }));
vi.mock('@/lib/facebook-page-connection', async () => ({ ...await vi.importActual<any>('@/lib/facebook-page-connection'), verifyFacebookPageConnection: m.verify, facebookWebhookConnectionStatus: m.health }));
vi.mock('@/lib/facebook-page-authorization', () => ({ verifyPageTokenApp: m.app, readFacebookPageGrant: m.grant, pageGraph: m.graph }));
import { POST } from './route';
const page = '00000000-0000-4000-8000-000000000010';
const post = (body: any, origin = 'https://veo.test') => POST(new NextRequest('https://veo.test/api/facebook/connect', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv('FACEBOOK_CLIENT_ID', 'app'); vi.stubEnv('VEO_ENFORCE_PAGE_RUNTIME_SCOPE', 'true');
    m.existing = null; m.stored = null; m.legacy = null;
    m.session.mockResolvedValue({ user: { id: 'owner' } }); m.scope.mockResolvedValue({ user_id: 'owner', role: 'owner', tenant_id: 'tenant', launch_at: '2026-11-01' });
    m.app.mockResolvedValue(undefined); m.verify.mockResolvedValue({ id: '123', name: 'Verified Page' }); m.health.mockResolvedValue('ready'); m.subscription.mockResolvedValue(undefined);
    m.grant.mockResolvedValue({ token: 'private-user-token' }); m.graph.mockResolvedValue({ id: '123', access_token: 'private-page-token' }); m.rpc.mockResolvedValue({ data: { id: page, created: true } });
});
afterEach(() => { vi.unstubAllEnvs(); });
it('verifies the app, Page and inbox, then saves a new ID without a static name restriction or exposing tokens', async () => {
    const response = await post({ facebookPageId: '123', source: 'authorization', accessToken: 'untrusted-browser-token' });
    expect(response.status).toBe(200); expect(m.app).toHaveBeenCalledWith('private-page-token'); expect(m.verify).toHaveBeenCalledWith('123', 'private-page-token');
    expect(m.rpc).toHaveBeenCalledWith('veo_connect_page', { p_actor: 'owner', p_facebook_id: '123', p_name: 'Verified Page', p_token: 'private-page-token', p_app: 'app' });
    expect(m.subscription).toHaveBeenCalledWith('123', 'private-page-token', ['messages', 'messaging_postbacks', 'message_echoes', 'messaging_referrals'], expect.any(AbortSignal));
    expect(JSON.stringify(await response.json())).not.toContain('private-');
});
it.each(['member', 'manager', 'team_leader'])('denies %s before inspecting tokens or writing connections', async role => {
    m.scope.mockResolvedValue({ role, launch_at: '2026-11-01' });
    expect((await post({ facebookPageId: '123' })).status).toBe(403); expect(m.verify).not.toHaveBeenCalled(); expect(m.rpc).not.toHaveBeenCalled();
});
it('rejects anonymous and cross-origin requests', async () => {
    expect((await post({}, 'https://other.test')).status).toBe(403);
    m.session.mockResolvedValue(null); expect((await post({})).status).toBe(401); expect(m.rpc).not.toHaveBeenCalled();
});
it('cannot take over another tenant’s Page or an unassigned legacy Page', async () => {
    for (const tenant of ['foreign-tenant', null]) { m.existing = { id: page, veo_tenant_id: tenant }; expect((await post({ facebookPageId: '123' })).status).toBe(403); }
    expect(m.verify).not.toHaveBeenCalled(); expect(m.subscription).not.toHaveBeenCalled(); expect(m.rpc).not.toHaveBeenCalled();
});
it('retains verified credentials with explicit incomplete status when webhook setup fails', async () => {
    m.subscription.mockRejectedValue(new Error('private upstream details'));
    const response = await post({ facebookPageId: '123' }); expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ saved: true, success: false, code: 'WEBHOOK_SETUP_INCOMPLETE', webhookSubscribed: false }); expect(m.rpc.mock.calls[0][1].p_app).toBeNull();
});
it('reconnects a saved Page using only that tenant’s stored credential', async () => {
    m.stored = { id: page, fb_page_id: '123', access_token: 'stored-token', veo_tenant_id: 'tenant' };
    m.existing = { id: page, veo_tenant_id: 'tenant' }; m.rpc.mockResolvedValue({ data: { id: page, created: false } });
    const response = await post({ source: 'stored', pageId: page }); expect(response.status).toBe(200);
    expect(m.app).toHaveBeenCalledWith('stored-token'); expect(m.grant).not.toHaveBeenCalled(); expect((await response.json()).created).toBe(false);
});
it('accepts a manual token only after verification and never saves failed credentials', async () => {
    m.verify.mockRejectedValue(new Error('verification failed'));
    expect((await post({ source: 'manual', facebookPageId: '123', pageAccessToken: 'manual-token' })).status).toBe(503);
    expect(m.app).toHaveBeenCalledWith('manual-token'); expect(m.rpc).not.toHaveBeenCalled(); expect(m.subscription).not.toHaveBeenCalled();
});
