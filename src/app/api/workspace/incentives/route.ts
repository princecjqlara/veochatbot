import { NextRequest, NextResponse } from 'next/server';
import { dealChecked } from '@/lib/veo-deal-review';
import { getSupabaseAdmin } from '@/lib/supabase';
import { uuid, workspaceScope } from '@/lib/veo-workspace';
import { getSessionFromRequest } from '@/lib/get-session';
async function incentiveScope(r: NextRequest) {
 const session = await getSessionFromRequest(r);
 if (!session?.user?.id) throw Object.assign(Error('Sign in required'), { status: 401 });
 const scope = await workspaceScope(session.user.id, r);
 if (!scope?.launch_at) throw Object.assign(Error('Workspace access is inactive'), { status: 403 });
 return scope;
}
export const dynamic = 'force-dynamic';
const reply = (b: any, status = 200) => NextResponse.json(b, { status, headers: { 'Cache-Control': 'no-store' } });
export async function GET(r: NextRequest) {
    try {
        const scope = await incentiveScope(r), kind = r.nextUrl.searchParams.get('kind'), id = r.nextUrl.searchParams.get('id');
        if (!['receipt', 'review'].includes(kind || '') || !uuid(id)) throw Error('Choose a receipt or deal');
        return reply(dealChecked(await getSupabaseAdmin().rpc('veo_incentive_context', { p_actor: scope.user_id, p_kind: kind, p_id: id })));
    } catch (e: any) { return reply({ error: e.message }, e.status || 400); }
}
export async function POST(r: NextRequest) {
    try {
        if (r.headers.get('origin') !== r.nextUrl.origin) return reply({ error: 'Same-origin request required' }, 403);
        const scope = await incentiveScope(r);
        if (!['manager', 'team_leader'].includes(scope.role)) return reply({ error: 'Manager or Team Leader access required' }, 403);
        const b = await r.json();
        if (!['receipt', 'review'].includes(b.kind) || !uuid(b.id) || !uuid(b.request_id) || typeof b.percent !== 'number' || !Number.isFinite(b.percent) || b.percent < 0 || b.percent > 60 || !Number.isSafeInteger(b.expected_version) || b.expected_version < 0 || typeof b.reason !== 'string' || b.reason.trim().length < 3 || b.reason.length > 500 || typeof b.save_reason !== 'boolean') throw Error('Choose a deal, percentage and reason');
        return reply(dealChecked(await getSupabaseAdmin().rpc('veo_incentive_save', { p_actor: scope.user_id, p_kind: b.kind, p_id: b.id, p_percent: b.percent, p_reason: b.reason.trim(), p_expected: b.expected_version, p_request: b.request_id, p_save_reason: b.save_reason })));
    } catch (e: any) { return reply({ error: e.message }, e.status || 400); }
}
