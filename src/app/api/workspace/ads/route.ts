import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { workspaceScope, philippineDate } from '@/lib/veo-workspace';
import { getUserPageIds } from '@/lib/page-access';
import { beginFacebookPageAuthorization, pageAuthorizationConfigured, readFacebookPageGrant, recoverFacebookAdsAuthorization } from '@/lib/facebook-page-authorization';
import { refreshStoredWorkspaceAds } from '@/lib/veo-stored-ads-refresh';
import { bootstrapPageAds } from '@/lib/veo-page-ads-bootstrap';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
const json = (body: any, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
async function access(request: NextRequest, mutation = false) {
    const session = await getSessionFromRequest(request), scope = session?.user?.id ? await workspaceScope(session.user.id, request) : null;
    if (!scope?.launch_at || !['owner', 'team_leader'].includes(scope.role) || mutation && scope.role !== 'owner') throw Object.assign(Error('Workspace Owner access is required to connect or refresh Meta Ads.'), { status: session?.user?.id ? 403 : 401 });
    if (mutation && request.headers.get('origin') !== request.nextUrl.origin) throw Object.assign(Error('Open this action from your workspace.'), { status: 403 });
    return scope;
}
export async function GET(request: NextRequest) {
    try {
        const scope = await access(request), db = getSupabaseAdmin(), tenant = await db.from('veo_tenants').select('owner_id').eq('id', scope.tenant_id).single();
        if (tenant.error) throw Error('Advertising connection status is unavailable');
        const credential = await db.from('meta_ads_credentials').select('credential_origin,token_expires_at,last_synced_at,last_error,refresh_lease_until,sync_checkpoint,next_scheduled_refresh_at,scheduled_refresh_started_at,scheduled_refresh_finished_at,scheduled_refresh_status').eq('user_id', tenant.data.owner_id).maybeSingle();
        if (credential.error) throw Error('Advertising connection status is unavailable');
        const c = credential.data, expired = c?.token_expires_at && Date.parse(c.token_expires_at) <= Date.now();
        const nextRefresh = c ? Math.max(c.next_scheduled_refresh_at ? Date.parse(c.next_scheduled_refresh_at) : 0, c.last_synced_at ? Date.parse(c.last_synced_at) + 3600000 : 0) : 0;
        const inventory = await db.from('ad_source_catalog').select('ad_id', { count: 'exact', head: true }).in('page_id', scope.page_ids).eq('metadata_source', 'marketing_api');
        if (inventory.error) throw Error('Creative inventory status is unavailable');
        const referrals = await db.rpc('get_visible_ad_catalog', { p_page_ids: scope.page_ids, p_from: null, p_to: new Date().toISOString() });
        if (referrals.error || !Array.isArray(referrals.data)) throw Error('Recorded ad-reference status is unavailable');
        const pendingAuthorization = scope.role === 'owner' ? !!await readFacebookPageGrant(request, scope.user_id, db, scope.tenant_id) : false;
        return json({ status: !c ? 'connect_required' : expired ? 'reconnect_required' : 'connected', can_manage: scope.role === 'owner', configured: pageAuthorizationConfigured(),
            pending_authorization: pendingAuthorization, automatic_sync: !!c && !expired, can_reuse_page_access: !c && scope.role === 'owner' && scope.page_ids.length > 0, credential_origin: c?.credential_origin || null, sync_interval_minutes: 60, scheduler: 'existing_follow_up_cron', initial_fetch_pending: !!c?.sync_checkpoint,
            next_scheduled_refresh_at:nextRefresh ? new Date(nextRefresh).toISOString() : null,scheduled_refresh_status:c?.scheduled_refresh_status||null,
            expires_at: c?.token_expires_at || null, last_synced_at: c?.last_synced_at || null, last_error: c?.last_error || null,
            refresh_running: !!c?.refresh_lease_until && Date.parse(c.refresh_lease_until) > Date.now(), verified_inventory_ads: inventory.count || 0, recorded_referral_ads: referrals.data.filter((a: any) => Number(a.referral_events) > 0).length,
            message: !c ? 'Checking whether your existing Page connections can supply ad-account read access. Saved Page access is reused automatically when verified; Connect Meta Ads is available if renewed access is needed.' : expired ? 'Meta advertising access has expired. Reconnect Meta Ads to resume hourly imports; saved reports remain available.' : c.credential_origin === 'connected_page' ? 'Advertising access is connected through an existing authorized Page. Hourly imports read creative inventory, budgets, spend and delivery metrics. Current-day results remain provisional.' : 'Automatic imports read creative inventory, budgets, spend and delivery metrics hourly through your existing external scheduler. Current-day results remain provisional.' });
    } catch (e: any) { return json({ error: e.message || 'Advertising status is unavailable' }, e.status || 503); }
}
export async function POST(request: NextRequest) {
    try {
        const scope = await access(request, true), body = await request.json();
        if (body.action === 'authorize') return await beginFacebookPageAuthorization(request, 'ads');
        if (body.action === 'recover') return await recoverFacebookAdsAuthorization(request);
        if (body.action === 'discover') return json(await bootstrapPageAds({ db: getSupabaseAdmin(), user: scope.user_id, authorize: () => getUserPageIds(scope.user_id) }));
        if (body.action !== 'refresh') return json({ error: 'Choose connect or fetch advertising data' }, 400);
        const valid = (date: any) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date;
        if (!valid(body.from) || !valid(body.to) || body.from > body.to || body.to > philippineDate() || Date.parse(body.to) - Date.parse(body.from) > 92 * 86400000) return json({ error: 'Choose up to 93 real Philippine dates through today' }, 400);
        const result = await refreshStoredWorkspaceAds({ db: getSupabaseAdmin(), user: scope.user_id, from: body.from, to: body.to, authorize: () => getUserPageIds(scope.user_id) });
        return json({ ...result, budgets_changed: 0, messages_sent: 0 }, result.complete ? 200 : 503);
    } catch (e: any) { return json({ error: e.message || 'Advertising refresh failed', code: e.code, requiresReconnect: !!e.requiresReconnect || e.code === 'ADS_RECONNECT_REQUIRED' || e.code === 'ADS_TOKEN_INVALID' }, e.status || 503); }
}
