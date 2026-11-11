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
        if (!scope?.launch_at || scope.role !== 'owner') return reply({ error: 'Owner access required' }, 403);
        const result = await readVeoRpc(getSupabaseAdmin(), 'veo_account_access', { p_actor: scope.user_id });
        if (result.error) return reply({ error: 'Account sign-in status is temporarily unavailable' }, 503);
        return reply(result.data);
    } catch { return reply({ error: 'Account sign-in status is temporarily unavailable' }, 503); }
}
