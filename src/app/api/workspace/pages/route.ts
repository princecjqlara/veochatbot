import { NextRequest } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { fetchAllSupabaseRows } from '@/lib/supabase-pagination';
import { requestDeadline } from '@/lib/request-deadline';
import { facebookWebhookConnectionStatus } from '@/lib/facebook-page-connection';
import { pageConnectionCache } from '@/lib/page-connection-cache';
import { pageAuthorizationConfigured, pageCallbackUrl, readFacebookPageGrant, pageGraph } from '@/lib/facebook-page-authorization';
import { pageSetupFailure, pageSetupResponse, requirePageOwner } from '@/lib/veo-page-connections';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function GET(request: NextRequest) {
    try {
        const scope = await requirePageOwner(request), db = getSupabaseAdmin();
        const [rows, authorization] = await Promise.all([
            requestDeadline(signal => fetchAllSupabaseRows<any>(db.from('pages').select('id,fb_page_id,name,veo_enabled,automation_app_id,access_token,created_at,updated_at')
                .eq('veo_tenant_id', scope.tenant_id).order('name').order('id').abortSignal(signal)), 10000),
            readFacebookPageGrant(request, scope.user_id, db, scope.tenant_id)
        ]);
        const pages: any[] = new Array(rows.length); let next = 0;
        await Promise.all(Array.from({ length: Math.min(rows.length, 6) }, async () => {
            while (next < rows.length) {
                const index = next++, row = rows[index];
                const health = await pageConnectionCache.read([row.id, row.fb_page_id, row.access_token || '', process.env.FACEBOOK_CLIENT_ID || '', 'true'], async () => {
                    if (!row.access_token) return { tokenStatus: 'invalid' as const, webhookStatus: 'incomplete' as const };
                    let tokenStatus: 'valid' | 'invalid' | 'unknown' = 'unknown';
                    try { const identity = await pageGraph('me?fields=id', row.access_token, { timeout: 2500 }); tokenStatus = identity.id === row.fb_page_id ? 'valid' : 'invalid'; }
                    catch (error: any) { if (error.code === 'FACEBOOK_AUTHORIZATION_REQUIRED') tokenStatus = 'invalid'; }
                    const webhookStatus = tokenStatus === 'invalid' ? 'incomplete' : await facebookWebhookConnectionStatus(row.fb_page_id, row.access_token, process.env.FACEBOOK_CLIENT_ID);
                    return { tokenStatus, webhookStatus };
                }, request.nextUrl.searchParams.get('refresh') === '1');
                const runtimeReady = process.env.VEO_ENFORCE_PAGE_RUNTIME_SCOPE !== 'true' || row.automation_app_id === process.env.FACEBOOK_CLIENT_ID;
                const status = !row.veo_enabled ? 'disabled' : health.tokenStatus === 'invalid' ? 'reconnect_required' : health.webhookStatus === 'incomplete' || !runtimeReady ? 'setup_needed' : health.tokenStatus === 'valid' && health.webhookStatus === 'ready' ? 'ready' : 'unknown';
                pages[index] = { id: row.id, facebookPageId: row.fb_page_id, name: row.name, enabled: row.veo_enabled, status, createdAt: row.created_at, updatedAt: row.updated_at };
            }
        }));
        return pageSetupResponse({ pages, authorization: { active: !!authorization, expiresAt: authorization?.expiresAt || null, configured: pageAuthorizationConfigured() }, callbackUrl: pageCallbackUrl(request) });
    } catch (error) { return pageSetupFailure(error); }
}
