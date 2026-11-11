import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { workspaceScope, philippineDate } from '@/lib/veo-workspace';
import { getUserPageIds } from '@/lib/page-access';
import { beginFacebookPageAuthorization, pageAuthorizationConfigured, readFacebookPageGrant, recoverFacebookAdsAuthorization } from '@/lib/facebook-page-authorization';
import { refreshStoredWorkspaceAds } from '@/lib/veo-stored-ads-refresh';
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
        const credential = await db.from('meta_ads_credentials').select('token_expires_at,last_synced_at,last_error,refresh_lease_until,sync_checkpoint').eq('user_id', tenant.data.owner_id).maybeSingle();
        if (credential.error) throw Error('Advertising connection status is unavailable');
        const c = credential.data, expired = c?.token_expires_at && Date.parse(c.token_expires_at) <= Date.now();
        const inventory = await db.from('ad_source_catalog').select('ad_id', { count: 'exact', head: true }).in('page_id', scope.page_ids).eq('metadata_source', 'marketing_api');
        if (inventory.error) throw Error('Creative inventory status is unavailable');
        const pendingAuthorization = scope.role === 'owner' ? !!await readFacebookPageGrant(request, scope.user_id, db, scope.tenant_id) : false;
        return json({ status: !c ? 'connect_required' : expired ? 'reconnect_required' : 'connected', can_manage: scope.role === 'owner', configured: pageAuthorizationConfigured(),
            pending_authorization: pendingAuthorization, automatic_sync: !!c && !expired, sync_interval_minutes: 60, initial_fetch_pending: !!c?.sync_checkpoint,
            expires_at: c?.token_expires_at || null, last_synced_at: c?.last_synced_at || null, last_error: c?.last_error || null,
            refresh_running: !!c?.refresh_lease_until && Date.parse(c.refresh_lease_until) > Date.now(), verified_inventory_ads: inventory.count || 0,
            message: !c ? 'Page authorization is separate from advertising access. Connect Meta Ads to fetch budgets, creative metadata and spend.' : 'Fetch reads ad inventory, budgets and Insights; it does not change Meta ad budgets or send messages.' });
    } catch (e: any) { return json({ error: e.message || 'Advertising status is unavailable' }, e.status || 503); }
}
export async function POST(request: NextRequest) {
    try {
        const scope = await access(request, true), body = await request.json();
        if (body.action === 'authorize') return await beginFacebookPageAuthorization(request, 'ads');
        if (body.action === 'recover') return await recoverFacebookAdsAuthorization(request);
        if (body.action !== 'refresh') return json({ error: 'Choose connect or fetch advertising data' }, 400);
        const valid = (date: any) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date;
        if (!valid(body.from) || !valid(body.to) || body.from > body.to || body.to > philippineDate() || Date.parse(body.to) - Date.parse(body.from) > 92 * 86400000) return json({ error: 'Choose up to 93 real Philippine dates through today' }, 400);
        const result = await refreshStoredWorkspaceAds({ db: getSupabaseAdmin(), user: scope.user_id, from: body.from, to: body.to, authorize: () => getUserPageIds(scope.user_id) });
        return json({ ...result, budgets_changed: 0, messages_sent: 0 }, result.complete ? 200 : 503);
    } catch (e: any) { return json({ error: e.message || 'Advertising refresh failed', code: e.code, requiresReconnect: !!e.requiresReconnect || e.code === 'ADS_RECONNECT_REQUIRED' || e.code === 'ADS_TOKEN_INVALID' }, e.status || 503); }
}
