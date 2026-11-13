import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { workspaceScope, uuid } from '@/lib/veo-workspace';
import { getSupabaseAdmin } from '@/lib/supabase';
import { dealChecked } from '@/lib/veo-deal-review';
export const dynamic = 'force-dynamic';
const reply = (body: any, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
async function access(r: NextRequest) {
    const session = await getSessionFromRequest(r);
    if (!session?.user?.id) throw Object.assign(Error('Sign in required'), { status: 401 });
    const scope = await workspaceScope(session.user.id, r);
    if (!scope?.launch_at) throw Object.assign(Error('Workspace is inactive'), { status: 403 });
    return scope;
}
export async function GET(r: NextRequest) {
    try {
        const a = await access(r), worker = r.nextUrl.searchParams.get('worker_id') || a.user_id;
        if (!uuid(worker)) throw Error('Choose an employee');
        const db = getSupabaseAdmin();
        const policy = dealChecked(await db.rpc('veo_quota_policy', { p_actor: a.user_id, p_worker: worker, p_data: null }));
        return reply({ policy });
    } catch (e: any) { return reply({ error: e.message }, e.status || 400); }
}
export async function POST(r: NextRequest) {
    try {
        if (r.headers.get('origin') !== r.nextUrl.origin) return reply({ error: 'Same-origin request required' }, 403);
        const a = await access(r);
        if (!['owner', 'team_leader', 'manager'].includes(a.role)) return reply({ error: 'Supervisor access required' }, 403);
        const b = await r.json();
        if (!uuid(b.worker_id) || typeof b.carry_enabled !== 'boolean' || !Number.isInteger(b.max_carry) || b.max_carry < 0 || b.max_carry > 100 || typeof b.capacity_multiplier !== 'number' || !Number.isFinite(b.capacity_multiplier) || b.capacity_multiplier < 1 || b.capacity_multiplier > 3 || !Number.isSafeInteger(b.fallback_cpa_minor) || b.fallback_cpa_minor < 100 || b.fallback_cpa_minor > 100000000) throw Error('Enter valid quota limits and estimated acquisition cost');
        const policy = dealChecked(await getSupabaseAdmin().rpc('veo_quota_policy', { p_actor: a.user_id, p_worker: b.worker_id, p_data: { carry_enabled: b.carry_enabled, max_carry: b.max_carry, capacity_multiplier: b.capacity_multiplier, fallback_cpa_minor: b.fallback_cpa_minor } }));
        return reply({ policy });
    } catch (e: any) { return reply({ error: e.message }, e.status || 400); }
}
