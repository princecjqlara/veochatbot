import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { workspaceScope, uuid } from '@/lib/veo-workspace';
import { getSupabaseAdmin } from '@/lib/supabase';
import { fetchBusinessOrderNotices } from '@/lib/veo-business-orders';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const response = (body: any, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
async function run(request: NextRequest, refresh: boolean) {
    try {
        if (refresh && request.headers.get('origin') !== request.nextUrl.origin) return response({ error: 'Same-origin request required' }, 403);
        const session = await getSessionFromRequest(request);if (!session?.user?.id) return response({ error: 'Sign in required' }, 401);
        const scope = await workspaceScope(session.user.id), contactId = request.nextUrl.searchParams.get('contact_id');
        if (!scope?.launch_at) return response({ error: 'Workspace unavailable' }, 403);
        if (!uuid(contactId)) return response({ error: 'Choose a client' }, 400);
        const db = getSupabaseAdmin(), contact = await db.from('contacts').select('id,page_id,psid').eq('id', contactId).maybeSingle();
        if (contact.error || !contact.data || !scope.page_ids.includes(contact.data.page_id)) return response({ error: 'Client Page access denied' }, 403);
        let scan: any = null;
        if (refresh) {
            const page = await db.from('pages').select('fb_page_id,access_token').eq('id', contact.data.page_id).single();
            if (page.error || !page.data?.access_token || !contact.data.psid) return response({ error: 'Facebook Page connection unavailable' }, 503);
            scan = await fetchBusinessOrderNotices({ pageId: page.data.fb_page_id, psid: contact.data.psid, token: page.data.access_token, launchAt: scope.launch_at });
            // The database checks current Page grants again after the external read.
            const saved = await db.rpc('veo_observe_business_orders', { p_actor: scope.user_id, p_contact: contactId, p_orders: scan.orders });
            if (saved.error) return response({ error: saved.error.code === '42501' ? 'Page access changed' : 'Could not save Facebook order observations' }, saved.error.code === '42501' ? 403 : 503);
        }
        const listed = await db.rpc('veo_business_orders_page', { p_actor: scope.user_id, p_contact: contactId });
        if (listed.error) return response({ error: 'Order list unavailable' }, listed.error.code === '42501' ? 403 : 503);
        return response({ ...listed.data, ...(scan ? { scan: { complete: scan.complete, pages_checked: scan.pages_checked, coverage: scan.coverage, checked_at: new Date().toISOString() } } : {}) });
    } catch (e: any) { return response({ error: e.name === 'TimeoutError' ? 'Facebook order fetch timed out. Retry shortly.' : e.message || 'Facebook order fetch unavailable' }, 503); }
}
export const GET = (request: NextRequest) => run(request, false);
export const POST = (request: NextRequest) => run(request, true);
