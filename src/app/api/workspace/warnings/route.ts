import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { workspaceScope, uuid } from '@/lib/veo-workspace';
import { readVeoRpc } from '@/lib/veo-report-read';
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
