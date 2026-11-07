import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { workspaceScope, uuid } from '@/lib/veo-workspace';
import { readVeoRpc } from '@/lib/veo-report-read';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
const response = (data: any, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
async function access(request: NextRequest) {
    const session = await getSessionFromRequest(request);
    if (!session?.user?.id) throw Object.assign(Error('Sign in required'), { status: 401 });
    const scope = await workspaceScope(session.user.id);
    if (!scope?.launch_at) throw Object.assign(Error('Workspace access is inactive'), { status: 403 });
    return scope;
}
function checked(result: any) {
    if (result.error) throw Object.assign(Error(result.error.code === '57014' ? 'The request timed out. Refresh assignments before retrying.' : result.error.message || 'Client assignments unavailable'), { status: result.error.code === '42501' ? 403 : result.error.code === '23505' ? 409 : result.error.code === '57014' ? 503 : 400 });
    return result.data;
}
const fail = (e: any) => response({ error: e.code === 'DATABASE_UNAVAILABLE' ? 'Client assignments are temporarily unavailable' : e.message || 'Client assignments unavailable' }, e.status || (e.code === 'DATABASE_UNAVAILABLE' ? 503 : 400));
export async function GET(request: NextRequest) {
    try {
        const scope = await access(request), q = request.nextUrl.searchParams;
        if (q.get('context') === '1') return response({ scope });
        const page = q.get('page_id') || null, search = (q.get('search') || '').trim(), view = q.get('view') || 'pool', offset = Number(q.get('offset') || 0);
        if (page && !uuid(page) || search.length > 200 || !['pool', 'offers', 'assigned'].includes(view) || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw Error('Choose valid client filters');
        return response(checked(await readVeoRpc(getSupabaseAdmin(), 'veo_intake_page', { p_actor: scope.user_id, p_view: view, p_page: page, p_search: search, p_offset: offset }, 35000)));
    } catch (e) { return fail(e); }
}
export async function POST(request: NextRequest) {
    try {
        if (request.headers.get('origin') !== request.nextUrl.origin) throw Object.assign(Error('Same-origin request required'), { status: 403 });
        const scope = await access(request), body = await request.json();
        if (!uuid(body.request_id) || !['readiness', 'offer', 'accept', 'decline', 'cancel'].includes(body.action)) throw Error('Choose a valid client action');
        if (body.action === 'readiness') { if (!['ready', 'busy'].includes(body.status)) throw Error('Choose Ready or Busy'); }
        else {
            if (!uuid(body.contact_id) || body.offer_id && !uuid(body.offer_id) || body.action === 'offer' && !uuid(body.user_id) || ['decline', 'cancel'].includes(body.action) && !uuid(body.offer_id)) throw Error('Choose a client, worker and valid offer');
        }
        if (body.reason != null && (typeof body.reason !== 'string' || body.reason.trim().length > 500)) throw Error('Reassignment reasons must be at most 500 characters');
        return response({ saved: checked(await getSupabaseAdmin().rpc('veo_intake_action', { p_actor: scope.user_id, p_action: body.action, p_data: { request_id: body.request_id, contact_id: body.contact_id, user_id: body.user_id, offer_id: body.offer_id, status: body.status, reason: body.reason?.trim() } })) });
    } catch (e) { return fail(e); }
}
