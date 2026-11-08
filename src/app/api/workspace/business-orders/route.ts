import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { workspaceScope, uuid } from '@/lib/veo-workspace';
import { getSupabaseAdmin } from '@/lib/supabase';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const response = (body: any, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
async function run(request: NextRequest, refresh: boolean) {
    try {
        if (refresh && request.headers.get('origin') !== request.nextUrl.origin) return response({ error: 'Same-origin request required' }, 403);
        const session = await getSessionFromRequest(request);if (!session?.user?.id) return response({ error: 'Sign in required' }, 401);
        const scope = await workspaceScope(session.user.id, request), contactId = request.nextUrl.searchParams.get('contact_id');
        if (!scope?.launch_at) return response({ error: 'Workspace unavailable' }, 403);
        if (!uuid(contactId)) return response({ error: 'Choose a client' }, 400);
        const db = getSupabaseAdmin(), contact = await db.from('contacts').select('id,page_id,psid').eq('id', contactId).maybeSingle();
        if (contact.error || !contact.data || !scope.page_ids.includes(contact.data.page_id)) return response({ error: 'Client Page access denied' }, 403);
        let sync: any = null;
        if (refresh) {
            const queued = await db.rpc('veo_request_source_refresh', { p_actor: scope.user_id, p_contact: contactId });
            if (queued.error) return response({ error: queued.error.code === '42501' ? 'Page access changed' : 'Could not queue Facebook refresh' }, queued.error.code === '42501' ? 403 : 503);
        }
        const listed = await db.rpc('veo_business_orders_page', { p_actor: scope.user_id, p_contact: contactId });
        if (listed.error) return response({ error: 'Order list unavailable' }, listed.error.code === '42501' ? 403 : 503);
        const source = await db.rpc('veo_source_page', { p_actor: scope.user_id, p_contact: contactId });
        if (source.error) return response({ error: 'Facebook source status unavailable' }, source.error.code === '42501' ? 403 : 503);
        return response({ ...listed.data, source: source.data, ...(refresh ? { queued: true } : {}) });
    } catch (e: any) { return response({ error: e.name === 'TimeoutError' ? 'Facebook order fetch timed out. Retry shortly.' : e.message || 'Facebook order fetch unavailable' }, 503); }
}
export const GET = (request: NextRequest) => run(request, false);
export const POST = (request: NextRequest) => run(request, true);
