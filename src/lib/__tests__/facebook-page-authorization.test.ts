import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ owner: vi.fn(), rpc: vi.fn(), upsert: vi.fn(), update: vi.fn(), ads:vi.fn(), saved: { id: '00000000-0000-4000-8000-000000000099' } as any }));
vi.mock('@/lib/veo-ads-authorization',()=>({retainWorkspaceAdsGrant:m.ads}));
vi.mock('@/lib/veo-page-connections', async () => ({ ...await vi.importActual<any>('@/lib/veo-page-connections'), requirePageOwner: m.owner }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ rpc: m.rpc, from: () => {
    const q: any = { upsert: m.upsert, update: (values: any) => { m.update(values); return q; }, eq: () => q, select: () => q, maybeSingle: async () => ({ data: m.saved }) }; return q;
} }) }));
import { beginFacebookPageAuthorization, finishFacebookPageAuthorization, readFacebookPageGrant, verifyPageTokenApp, recoverFacebookAdsAuthorization } from '../facebook-page-authorization';
import { decryptPageGrant, encryptPageGrant, PAGE_AUTH_COOKIE, pageGrantCookie } from '../veo-page-connections';
const grantId = '00000000-0000-4000-8000-000000000099';
function callback(query = 'state=' + 's'.repeat(43) + '&code=private-auth-code', cookie = pageGrantCookie(grantId, 'owner')) {
    return new NextRequest('https://veo.test/api/auth/callback/facebook?' + query, { headers: { Cookie: PAGE_AUTH_COOKIE + '=' + cookie } });
}
beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv('NEXTAUTH_SECRET', 'private-test-secret'); vi.stubEnv('FACEBOOK_CLIENT_ID', 'app'); vi.stubEnv('FACEBOOK_CLIENT_SECRET', 'private-app-secret');
    m.owner.mockResolvedValue({ user_id: 'owner', tenant_id: 'tenant', role: 'owner', launch_at: '2026-11-01' }); m.rpc.mockResolvedValue({ data: true }); m.upsert.mockResolvedValue({ data: {} }); m.saved = { id: grantId };
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('starts a separate Page grant using hashed state and the existing callback URL', async () => {
    const response = await beginFacebookPageAuthorization(new NextRequest('https://veo.test/api/facebook/authorize', { method: 'POST', headers: { Origin: 'https://veo.test' } }));
    const url = new URL((await response.json()).authorizationUrl), state = url.searchParams.get('state')!;
    expect(url.hostname).toBe('www.facebook.com'); expect(state.length).toBeGreaterThan(32);
    expect(url.searchParams.get('redirect_uri')).toBe('https://veo.test/api/auth/callback/facebook');
    expect(m.upsert.mock.calls[0][0].state_hash).not.toBe(state); expect(m.upsert.mock.calls[0][0].token_ciphertext).toBeNull();
    const cookie = response.headers.get('set-cookie')!; expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=lax'); expect(cookie).not.toContain('next-auth.session-token');
});
it('binds advertising consent to the one-use Owner state and keeps Page sessions and login identity unchanged',async()=>{
    const start=await beginFacebookPageAuthorization(new NextRequest('https://veo.test/api/workspace/ads',{method:'POST',headers:{Origin:'https://veo.test'}}),'ads');
    const url=new URL((await start.json()).authorizationUrl);expect(url.searchParams.get('scope')).toContain('ads_read');expect(url.searchParams.get('scope')).not.toContain('ads_management');expect(url.searchParams.get('state')).toMatch(/^ads\./);
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({access_token:'private-short-token'})));m.ads.mockResolvedValue(undefined);
    const response=await finishFacebookPageAuthorization(callback('state=ads.'+'s'.repeat(43)+'&code=private-auth-code'));
    expect(response.headers.get('location')).toContain('view=budget');expect(response.headers.get('location')).toContain('ads_connected=1');
    expect(m.ads).toHaveBeenCalledWith(expect.anything(),'owner','private-short-token',expect.any(Function),expect.any(Function));expect(decryptPageGrant(m.update.mock.calls[0][0].token_ciphertext)).toBe('private-short-token');expect(response.headers.get('set-cookie')).not.toContain('next-auth.session-token');
    expect(url.searchParams.get('scope')?.split(',')).toEqual(['ads_read','business_management','pages_show_list']);
});
it('keeps a consumed OAuth code recoverable through its encrypted grant when Meta token exchange fails',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({access_token:'private-short-token',expires_in:3600})));
    const {PageSetupError}=await import('../veo-page-connections');m.ads.mockRejectedValueOnce(new PageSetupError('Temporary exchange failure',503,'ADS_TOKEN_EXCHANGE_FAILED'));
    const response=await finishFacebookPageAuthorization(callback('state=ads.'+'s'.repeat(43)+'&code=private-auth-code'));
    expect(response.headers.get('location')).toContain('ADS_TOKEN_EXCHANGE_FAILED');expect(response.headers.get('set-cookie')).not.toContain('Max-Age=0');
    expect(JSON.stringify(response.headers.get('location'))).not.toContain('private-short-token');
    m.saved={id:grantId,tenant_id:'tenant',state_used_at:new Date().toISOString(),token_ciphertext:m.update.mock.calls[0][0].token_ciphertext,expires_at:new Date(Date.now()+60000).toISOString()};m.ads.mockResolvedValue(undefined);m.rpc.mockClear();
    const retry=await recoverFacebookAdsAuthorization(callback());expect(retry.status).toBe(200);expect(await retry.json()).toMatchObject({connected:true,automatic_sync:true});expect(m.rpc).not.toHaveBeenCalled();expect(m.ads.mock.calls.at(-1)?.[2]).toBe('private-short-token');
});
it('uses a GET token extension and server-side token inspection with no credentials returned to the browser',async()=>{
    const fetcher=vi.fn(async(_url:any,_options?:any)=>Response.json({access_token:'private-short-token'}));vi.stubGlobal('fetch',fetcher);
    m.ads.mockImplementationOnce(async(_db,_actor,_token,exchange,inspect)=>{await exchange('private-short-token');await inspect('private-long-token');});
    const response=await finishFacebookPageAuthorization(callback('state=ads.'+'s'.repeat(43)+'&code=private-auth-code'));
    expect(response.headers.get('location')).toContain('ads_connected=1');
    const extension=fetcher.mock.calls.find(([url])=>new URL(String(url)).searchParams.get('grant_type')==='fb_exchange_token');expect(extension?.[1]).toMatchObject({method:'GET'});
    expect(fetcher.mock.calls.some(([url])=>new URL(String(url)).pathname.endsWith('/debug_token'))).toBe(true);
});
it('exchanges the code only after claiming state, encrypts the grant and keeps VEO identity unchanged', async () => {
    const fetcher = vi.fn(async (_url: any, options: any) => { expect(options.body.get('code')).toBe('private-auth-code'); return Response.json({ access_token: 'private-user-token' }); }); vi.stubGlobal('fetch', fetcher);
    const response = await finishFacebookPageAuthorization(callback());
    expect(new URL(response.headers.get('location')!).searchParams.get('authorized')).toBe('1');
    expect(m.rpc).toHaveBeenCalledWith('veo_claim_page_authorization', expect.objectContaining({ p_actor: 'owner', p_id: grantId }));
    expect(m.rpc.mock.invocationCallOrder[0]).toBeLessThan(fetcher.mock.invocationCallOrder[0]);
    expect(decryptPageGrant(m.update.mock.calls[0][0].token_ciphertext)).toBe('private-user-token');
    expect(response.headers.get('set-cookie')).not.toContain('next-auth.session-token'); expect(response.headers.get('location')).not.toContain('private-');
});
it('rejects expired or replayed state and actor-mismatched cookies before token exchange', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); m.rpc.mockResolvedValue({ data: false });
    const response = await finishFacebookPageAuthorization(callback()); expect(response.headers.get('location')).toContain('INVALID_STATE'); expect(fetcher).not.toHaveBeenCalled();
    m.rpc.mockClear(); await finishFacebookPageAuthorization(callback(undefined, pageGrantCookie(grantId, 'another-owner'))); expect(m.rpc).not.toHaveBeenCalled();
});
it('handles cancelled authorization without replacing saved credentials', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const response = await finishFacebookPageAuthorization(callback('state=' + 's'.repeat(43) + '&error=access_denied'));
    expect(response.headers.get('location')).toContain('AUTHORIZATION_CANCELLED'); expect(m.update).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});
it('rejects tokens issued for another app and expired tokens', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { is_valid: true, app_id: 'other-app' } })));
    await expect(verifyPageTokenApp('private-page-token')).rejects.toMatchObject({ code: 'FACEBOOK_APP_MISMATCH' });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { is_valid: true, app_id: 'app', expires_at: 1 } })));
    await expect(verifyPageTokenApp('private-page-token')).rejects.toMatchObject({ code: 'FACEBOOK_APP_MISMATCH' });
});
it('requires an unexpired encrypted grant in the current tenant before returning server-side credentials', async () => {
    m.saved = { id: grantId, tenant_id: 'tenant', state_used_at: new Date().toISOString(), token_ciphertext: encryptPageGrant('private-user-token'), expires_at: new Date(Date.now() + 60000).toISOString() };
    expect((await readFacebookPageGrant(callback(), 'owner', undefined, 'tenant'))?.token).toBe('private-user-token');
    expect(await readFacebookPageGrant(callback(), 'owner', undefined, 'another-tenant')).toBeNull();
    const ciphertext = m.saved.token_ciphertext; m.saved.token_ciphertext = 'invalid-encrypted-grant';
    expect(await readFacebookPageGrant(callback(), 'owner', undefined, 'tenant')).toBeNull(); m.saved.token_ciphertext = ciphertext;
    m.saved.expires_at = new Date(Date.now() - 1).toISOString(); expect(await readFacebookPageGrant(callback(), 'owner', undefined, 'tenant')).toBeNull();
});
