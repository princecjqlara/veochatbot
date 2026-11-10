import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from './supabase';
import { FACEBOOK_PERMISSION_SCOPE } from './facebook-permissions';
import { checkedPageResult, decryptPageGrant, encryptPageGrant, PageSetupError, PAGE_AUTH_COOKIE, pageSetupResponse, readPageGrantCookie, requirePageOwner, setPageGrantCookie } from './veo-page-connections';

export const FACEBOOK_PAGE_GRAPH = 'https://graph.facebook.com/v21.0';
export const pageCallbackUrl = (request: NextRequest) => new URL('/api/auth/callback/facebook', request.nextUrl.origin).toString();
export const pageAuthorizationConfigured = () => !!(process.env.FACEBOOK_CLIENT_ID && process.env.FACEBOOK_CLIENT_SECRET && process.env.NEXTAUTH_SECRET);

/** Return safe errors only; Graph responses can contain private credentials. */
export async function pageGraph(path: string, token?: string, options: { body?: URLSearchParams; timeout?: number } = {}): Promise<any> {
    let response: Response, body: any;
    try {
        response = await fetch(FACEBOOK_PAGE_GRAPH + '/' + path, { method: options.body ? 'POST' : 'GET',
            headers: token ? { Authorization: 'Bearer ' + token } : undefined, body: options.body,
            cache: 'no-store', signal: AbortSignal.timeout(options.timeout || 12000) });
        body = await response.json();
    } catch { throw new PageSetupError('Facebook is temporarily unavailable. Retry shortly.', 503, 'FACEBOOK_UNAVAILABLE'); }
    if (!response.ok || body.error) {
        const reauth = [10, 190, 200].includes(Number(body.error?.code));
        throw new PageSetupError(reauth ? 'Facebook needs renewed Page permissions. Refresh permissions and approve access to the Page.' : 'Facebook could not complete this request. Retry shortly.', reauth ? 409 : 503, reauth ? 'FACEBOOK_AUTHORIZATION_REQUIRED' : 'FACEBOOK_UNAVAILABLE');
    }
    return body;
}
export async function verifyPageTokenApp(token: string) {
    if (!pageAuthorizationConfigured()) throw new PageSetupError('Facebook Page setup is not configured on this server.', 503, 'SETUP_UNAVAILABLE');
    const result = await pageGraph('debug_token?' + new URLSearchParams({ input_token: token }), `${process.env.FACEBOOK_CLIENT_ID}|${process.env.FACEBOOK_CLIENT_SECRET}`);
    if (result.data?.is_valid !== true || String(result.data.app_id) !== process.env.FACEBOOK_CLIENT_ID ||
        result.data.expires_at && result.data.expires_at * 1000 <= Date.now()) throw new PageSetupError('Use a valid Page access token issued for this workspace’s Facebook app.', 409, 'FACEBOOK_APP_MISMATCH');
}
export async function readFacebookPageGrant(request: NextRequest, actor: string, db = getSupabaseAdmin(), tenantId?: string) {
    const id = readPageGrantCookie(request, actor);
    if (!id) return null;
    const row = checkedPageResult(await db.from('veo_page_authorizations').select('id,actor_id,tenant_id,token_ciphertext,state_used_at,expires_at')
        .eq('id', id).eq('actor_id', actor).maybeSingle());
    if (!row?.token_ciphertext || !row.state_used_at || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= Date.now() || tenantId && row.tenant_id !== tenantId) return null;
    try { return { id: row.id as string, token: decryptPageGrant(row.token_ciphertext), expiresAt: row.expires_at as string }; }
    catch (error) {
        // A rotated application secret invalidates only the temporary grant.
        // Keep the saved directory usable so the Owner can authorize again.
        if (error instanceof PageSetupError) return null;
        throw error;
    }
}
export async function beginFacebookPageAuthorization(request: NextRequest) {
    const scope = await requirePageOwner(request, true);
    if (!pageAuthorizationConfigured()) throw new PageSetupError('Facebook Page setup is not configured on this server.', 503, 'SETUP_UNAVAILABLE');
    const id = randomUUID(), state = randomBytes(32).toString('base64url');
    checkedPageResult(await getSupabaseAdmin().from('veo_page_authorizations').upsert({ id, actor_id: scope.user_id, tenant_id: scope.tenant_id,
        state_hash: createHash('sha256').update(state).digest('hex'), state_used_at: null, token_ciphertext: null,
        expires_at: new Date(Date.now() + 600000).toISOString(), created_at: new Date().toISOString() }, { onConflict: 'actor_id' }));
    const url = new URL('https://www.facebook.com/v21.0/dialog/oauth');
    url.search = new URLSearchParams({ client_id: process.env.FACEBOOK_CLIENT_ID!, redirect_uri: pageCallbackUrl(request), state, response_type: 'code', scope: FACEBOOK_PERMISSION_SCOPE, auth_type: 'rerequest' }).toString();
    const response = pageSetupResponse({ authorizationUrl: url.toString() });
    setPageGrantCookie(response, request, scope.user_id, id, 600);
    return response;
}
export async function finishFacebookPageAuthorization(request: NextRequest) {
    const destination = new URL('/dashboard/connect', request.nextUrl.origin);
    try {
        const scope = await requirePageOwner(request), id = readPageGrantCookie(request, scope.user_id);
        const state = request.nextUrl.searchParams.get('state') || '', code = request.nextUrl.searchParams.get('code') || '';
        if (!id || state.length < 32 || state.length > 200) throw new PageSetupError('Start Facebook authorization again.', 400, 'INVALID_STATE');
        const db = getSupabaseAdmin();
        const claimed = checkedPageResult(await db.rpc('veo_claim_page_authorization', { p_actor: scope.user_id, p_id: id, p_state_hash: createHash('sha256').update(state).digest('hex') }));
        if (claimed !== true) throw new PageSetupError('Start Facebook authorization again.', 400, 'INVALID_STATE');
        if (request.nextUrl.searchParams.has('error')) throw new PageSetupError('Facebook authorization was cancelled.', 400, 'AUTHORIZATION_CANCELLED');
        if (!code || code.length > 4096) throw new PageSetupError('Facebook did not supply an authorization code.', 400, 'INVALID_STATE');
        const token = await pageGraph('oauth/access_token', undefined, { body: new URLSearchParams({ client_id: process.env.FACEBOOK_CLIENT_ID!, client_secret: process.env.FACEBOOK_CLIENT_SECRET!, redirect_uri: pageCallbackUrl(request), code }) });
        if (typeof token.access_token !== 'string' || !token.access_token || token.access_token.length > 8192) throw new PageSetupError('Facebook did not supply a usable authorization.', 409);
        // A short-lived grant supports Page selection; it never changes app identity.
        await requirePageOwner(request);
        const saved = checkedPageResult(await db.from('veo_page_authorizations').update({ token_ciphertext: encryptPageGrant(token.access_token), expires_at: new Date(Date.now() + 3600000).toISOString() })
            .eq('id', id).eq('actor_id', scope.user_id).select('id').maybeSingle());
        if (!saved) throw new PageSetupError('Start Facebook authorization again.', 409, 'INVALID_STATE');
        destination.searchParams.set('authorized', '1');
        const response = NextResponse.redirect(destination);
        response.headers.set('Cache-Control', 'no-store'); response.headers.set('Referrer-Policy', 'no-referrer');
        setPageGrantCookie(response, request, scope.user_id, id, 3600);
        return response;
    } catch (error) {
        destination.searchParams.set('connection_error', error instanceof PageSetupError ? error.code : 'SETUP_UNAVAILABLE');
        const response = NextResponse.redirect(destination);
        response.cookies.set(PAGE_AUTH_COOKIE, '', { httpOnly: true, secure: request.nextUrl.protocol === 'https:', sameSite: 'lax', path: '/api', maxAge: 0 });
        response.headers.set('Cache-Control', 'no-store'); response.headers.set('Referrer-Policy', 'no-referrer');
        return response;
    }
}
