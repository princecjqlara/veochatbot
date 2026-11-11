import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { workspaceScope } from '@/lib/veo-workspace';
import { getSupabaseAdmin } from '@/lib/supabase';
import { readVeoRpc } from '@/lib/veo-report-read';
export const dynamic = 'force-dynamic';
const reply = (body: any, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export async function GET(request: NextRequest) {
    try {
        const session = await getSessionFromRequest(request);
        if (!session?.user?.id) return reply({ error: 'Sign in required' }, 401);
        const scope = await workspaceScope(session.user.id, request);
        if (!scope?.launch_at || !['owner', 'team_leader'].includes(scope.role)) return reply({ error: 'Owner or Team Leader required' }, 403);
        const result = await readVeoRpc(getSupabaseAdmin(), 'veo_autotag_status', { p_actor: scope.user_id });
        if (result.error) return reply({ error: 'Auto-tag status is temporarily unavailable' }, 503);
        return reply(result.data);
    } catch { return reply({ error: 'Auto-tag status is temporarily unavailable' }, 503); }
}
