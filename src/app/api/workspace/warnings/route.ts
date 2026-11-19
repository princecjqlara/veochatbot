import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { workspaceScope, uuid } from '@/lib/veo-workspace';
import { readVeoRpc } from '@/lib/veo-report-read';
import { disciplinePayload } from '@/lib/veo-discipline';
import { isSupabaseUnavailable } from '@/lib/supabase-errors';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
export async function GET(request: NextRequest) {
    try {
        const session = await getSessionFromRequest(request);
        if (!session?.user?.id) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
        const scope = await workspaceScope(session.user.id, request);
        if (!scope?.launch_at) return NextResponse.json({ error: 'Workspace access inactive' }, { status: 403 });
        const worker = request.nextUrl.searchParams.get('worker_id') || null;
        if (worker && !uuid(worker)) return NextResponse.json({ error: 'Choose a staff account' }, { status: 400 });
        const result = await readVeoRpc(getSupabaseAdmin(), 'veo_workflow_warnings', { p_actor: scope.user_id, p_worker: worker });
        if (result.error) throw Object.assign(Error('Staff warnings are temporarily unavailable'), { status: result.error.code === '42501' ? 403 : 503 });
        return NextResponse.json(result.data, { headers: { 'Cache-Control': 'no-store' } });
    } catch (e: any) { return NextResponse.json({ error: e.message || 'Staff warnings unavailable' }, { status: e.status || 503, headers: { 'Cache-Control': 'no-store' } }); }
}
export async function POST(request: NextRequest) {
    const reply = (body: any, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
    try {
        if (request.headers.get('origin') !== request.nextUrl.origin) return reply({ error: 'Same-origin request required' }, 403);
        const session = await getSessionFromRequest(request);
        if (!session?.user?.id) return reply({ error: 'Sign in required' }, 401);
        const scope = await workspaceScope(session.user.id, request);
        if (!scope?.launch_at || !['owner', 'manager', 'team_leader'].includes(scope.role)) return reply({ error: 'Manager or Team Leader access required' }, 403);
        const body = await request.json(), data = disciplinePayload(body);
        const result = await getSupabaseAdmin().rpc('veo_discipline_action', { p_actor: scope.user_id, p_action: body.action, p_data: data });
        if (result.error) {
            if (isSupabaseUnavailable(result.error)) return reply({ error: 'The change could not be confirmed. Refresh this member’s warning and suspension status before retrying.' }, 503);
            return reply({ error: result.error.message || 'Could not save this change' }, result.error.code === '42501' ? 403 : ['23505', 'PT409', '40001'].includes(result.error.code) ? 409 : 400);
        }
        return reply(result.data);
    } catch (error: any) { return reply({ error: error.message || 'Could not save this change' }, error.status || 400); }
}
