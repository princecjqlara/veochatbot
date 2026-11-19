import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { workspaceScope, uuid } from '@/lib/veo-workspace';
import { readVeoRpc } from '@/lib/veo-report-read';
import { isSupabaseUnavailable } from '@/lib/supabase-errors';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const reply = (data: any, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
async function actor(request: NextRequest) {
    const session = await getSessionFromRequest(request);
    if (!session?.user?.id) throw Object.assign(Error('Sign in required'), { status: 401 });
    const scope = await workspaceScope(session.user.id, request);
    if (!scope?.launch_at || !['owner', 'manager', 'team_leader'].includes(scope.role)) throw Object.assign(Error('Owner, Manager or Team Leader access required'), { status: 403 });
    return session.user.id;
}
function checked(result: any) {
    if (result.error) throw Object.assign(Error(result.error.message || 'Assignment unavailable'), {
        status: result.error.code === '42501' ? 403 : ['PT409', '23505'].includes(result.error.code) ? 409 : isSupabaseUnavailable(result.error) ? 503 : 400
    });
    return result.data;
}
function failure(error: any) {
    const status = error.status || 400;
    return reply({ error: status === 503 ? 'Assignment availability could not be confirmed. Reload the current assignment before saving again.' : error.message || 'Assignment unavailable' }, status);
}
export async function GET(request: NextRequest) {
    try {
        const user = await actor(request), contact = request.nextUrl.searchParams.get('contact_id');
        if (!uuid(contact)) throw Error('Choose a client');
        return reply(checked(await readVeoRpc(getSupabaseAdmin(), 'veo_client_assignment_context', { p_actor: user, p_contact: contact })));
    } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
    try {
        if (request.headers.get('origin') !== request.nextUrl.origin) throw Object.assign(Error('Same-origin request required'), { status: 403 });
        const user = await actor(request), body = await request.json();
        if (!uuid(body.contact_id) || !uuid(body.seller_id) || !Object.prototype.hasOwnProperty.call(body, 'expected_owner_id') || body.expected_owner_id !== null && !uuid(body.expected_owner_id)) throw Error('Choose a client and worker, and load the current assignment');
        if (typeof body.reason !== 'string' || body.reason.trim().length < 3 || body.reason.trim().length > 500) throw Error('Enter an assignment reason of 3 to 500 characters');
        return reply(checked(await getSupabaseAdmin().rpc('veo_manual_client_assignment', { p_actor: user, p_contact: body.contact_id, p_seller: body.seller_id, p_expected_owner: body.expected_owner_id, p_reason: body.reason.trim() })));
    } catch (error) { return failure(error); }
}
