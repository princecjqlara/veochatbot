import { NextRequest } from 'next/server';
import { getSupabaseAdmin } from './supabase';
import { pageGraph, readFacebookPageGrant, verifyPageTokenApp } from './facebook-page-authorization';
import { FacebookPageConnectionError, facebookWebhookConnectionStatus, verifyFacebookPageConnection } from './facebook-page-connection';
import { subscribePageToAppWebhook } from './facebook';
import { checkedPageResult, PageSetupError, pageSetupResponse, requirePageOwner } from './veo-page-connections';
import { requestDeadline } from './request-deadline';
import { pageConnectionCache } from './page-connection-cache';
import { uuid } from './veo-workspace';

export async function connectOwnerPage(request: NextRequest) {
    const scope = await requirePageOwner(request, true), db = getSupabaseAdmin();
    let body: any;
    try { body = await request.json(); } catch { throw new PageSetupError('Choose a Page and retry.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.source && !['stored', 'manual', 'authorization'].includes(body.source)) throw new PageSetupError('Choose a valid Page connection method.');
    let facebookId = body.facebookPageId, token: string | null = null;
    if (body.source === 'stored') {
        if (!uuid(body.pageId)) throw new PageSetupError('Choose a saved Page.');
        const row = checkedPageResult(await db.from('pages').select('id,fb_page_id,access_token,veo_tenant_id').eq('id', body.pageId).eq('veo_tenant_id', scope.tenant_id).maybeSingle());
        if (!row) throw new PageSetupError('This Page is outside your workspace.', 403, 'PAGE_FORBIDDEN');
        facebookId = row.fb_page_id; token = row.access_token;
    }
    if (typeof facebookId !== 'string' || !/^\d{1,100}$/.test(facebookId)) throw new PageSetupError('Enter a valid numeric Facebook Page ID.');
    const existing = checkedPageResult(await db.from('pages').select('id,veo_tenant_id').eq('fb_page_id', facebookId).maybeSingle());
    if (existing && existing.veo_tenant_id !== scope.tenant_id) {
        const ownedLegacy = !existing.veo_tenant_id && checkedPageResult(await db.from('user_pages').select('page_id').eq('user_id', scope.user_id).eq('page_id', existing.id).maybeSingle());
        if (!ownedLegacy) throw new PageSetupError('This Page belongs to another workspace or owner.', 403, 'PAGE_FORBIDDEN');
    }
    if (body.source === 'manual') {
        if (typeof body.pageAccessToken !== 'string' || !body.pageAccessToken.trim() || body.pageAccessToken.length > 8192) throw new PageSetupError('Enter the Page access token.');
        token = body.pageAccessToken.trim();
    } else if (!token) {
        const grant = await readFacebookPageGrant(request, scope.user_id, db, scope.tenant_id);
        if (!grant) throw new PageSetupError('Refresh Facebook permissions to connect this Page.', 409, 'FACEBOOK_AUTHORIZATION_REQUIRED');
        const authorized = await pageGraph(facebookId + '?fields=id,name,access_token', grant.token);
        if (authorized.id !== facebookId || typeof authorized.access_token !== 'string' || !authorized.access_token) throw new PageSetupError('Facebook did not grant access to this Page. Refresh permissions and select the Page.', 409, 'FACEBOOK_AUTHORIZATION_REQUIRED');
        token = authorized.access_token;
    }
    await verifyPageTokenApp(token!);
    let verified: Awaited<ReturnType<typeof verifyFacebookPageConnection>>;
    try { verified = await verifyFacebookPageConnection(facebookId, token!); }
    catch (error) {
        if (error instanceof FacebookPageConnectionError) throw new PageSetupError(error.message, error.status, error.code);
        throw error;
    }
    if (!verified.name) throw new PageSetupError('Facebook did not confirm this Page’s name. Retry shortly.', 503, 'FACEBOOK_UNAVAILABLE');
    let ready = false, message = 'Page access saved. Live message updates could not be confirmed. Retry reconnect to finish setup.';
    try {
        await requestDeadline(signal => subscribePageToAppWebhook(facebookId, token!, ['messages', 'messaging_postbacks', 'message_echoes', 'messaging_referrals'], signal), 10000);
        ready = await facebookWebhookConnectionStatus(facebookId, token!, process.env.FACEBOOK_CLIENT_ID) === 'ready';
    } catch { /* Keep verified credentials for a deliberate retry; do not report setup complete. */ }
    const saved = checkedPageResult(await db.rpc('veo_connect_page', { p_actor: scope.user_id, p_facebook_id: facebookId,
        p_name: verified.name, p_token: token, p_app: ready && process.env.VEO_ENFORCE_PAGE_RUNTIME_SCOPE === 'true' ? process.env.FACEBOOK_CLIENT_ID : null }));
    if (!saved?.id) throw new PageSetupError('Page setup did not return a saved Page. Retry shortly.', 503);
    pageConnectionCache.clear();
    if (ready) message = saved.created ? 'Page connected. Assign access to your team and review chatbot settings.' : 'Page reconnected. Existing data and team assignments are preserved.';
    return pageSetupResponse({ success: ready, saved: true, pageId: saved.id, facebookPageId: facebookId, name: verified.name, created: saved.created, webhookSubscribed: ready, message,
        ...(!ready ? { code: 'WEBHOOK_SETUP_INCOMPLETE' } : {}) }, ready ? 200 : 409);
}
