import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { workspaceScope, uuid } from '@/lib/veo-workspace';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export async function GET(request: NextRequest) {
    return workspaceService(() => handleGET(request));
}
async function handleGET(request: NextRequest) {
    const session = await getSessionFromRequest(request);
    if (!session?.user?.id) return reply({ error: 'Sign in required' }, 401);
    const scope = await workspaceScope(session.user.id, request), contact = request.nextUrl.searchParams.get('contact_id');
    if (!scope?.launch_at) return reply({ error: 'Workspace unavailable' }, 403);
    if (!uuid(contact)) return reply({ error: 'Choose a client' }, 400);
    const result = await getSupabaseAdmin().rpc('veo_source_page', { p_actor: scope.user_id, p_contact: contact });
    return result.error ? reply({ error: result.error.code === '42501' ? 'Client Page access denied' : 'Source status unavailable' }, result.error.code === '42501' ? 403 : 503) : reply(result.data);
}
export async function POST(request: NextRequest) {
    return workspaceService(() => handlePOST(request));
}
async function handlePOST(request: NextRequest) {
    if (request.headers.get('origin') !== request.nextUrl.origin) return reply({ error: 'Same-origin request required' }, 403);
    const session = await getSessionFromRequest(request);
    if (!session?.user?.id) return reply({ error: 'Sign in required' }, 401);
    const scope = await workspaceScope(session.user.id, request);
    if (!scope?.launch_at) return reply({ error: 'Workspace unavailable' }, 403);
    let body: any;
    try { body = await request.json(); } catch { return reply({ error: 'Invalid request' }, 400); }
    if (!uuid(body.contact_id)) return reply({ error: 'Choose a client' }, 400);
    const db = getSupabaseAdmin();
    if (body.action === 'refresh') {
        const queued = await db.rpc('veo_request_source_refresh', { p_actor: scope.user_id, p_contact: body.contact_id });
        return queued.error ? reply({ error: queued.error.code === '42501' ? 'Client Page access denied' : 'Could not queue Facebook refresh' }, queued.error.code === '42501' ? 403 : 503) : reply({ queued: true, status: queued.data?.status });
    }
    if (body.action === 'review') {
        if (!['qualified', 'converted'].includes(body.stage) || typeof body.reference !== 'string' || typeof body.reason !== 'string' || body.order_id && !uuid(body.order_id)) return reply({ error: 'Choose a stage and provide the actual source reference and review reason' }, 400);
        const reviewed = await db.rpc('veo_review_source_evidence', { p_actor: scope.user_id, p_contact: body.contact_id, p_stage: body.stage, p_reference: body.reference, p_reason: body.reason, p_order: body.order_id || null });
        return reviewed.error ? reply({ error: reviewed.error.code === '42501' ? 'Supervisor Page access required' : reviewed.error.message }, reviewed.error.code === '42501' ? 403 : 400) : reply(reviewed.data);
    }
    return reply({ error: 'Unknown source action' }, 400);
}
import { workspaceService } from '@/lib/workspace-service';
