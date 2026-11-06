import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { workspaceScope, philippineDate } from '@/lib/veo-workspace';
import { pageBudgetData, savePageBudget } from '@/lib/veo-budget';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
async function actor(request: NextRequest) {
    const s = await getSessionFromRequest(request), scope = s?.user?.id && await workspaceScope(s.user.id);
    if (!scope || !scope.launch_at || !['owner', 'team_leader'].includes(scope.role)) throw Object.assign(new Error('Owner or Team Leader access required'), { status: s?.user?.id ? 403 : 401 });
    return scope;
}
const failure = (e: any) => NextResponse.json({ error: e.message || 'Budget planning unavailable' }, { status: e.status || 400, headers: { 'Cache-Control': 'no-store' } });
export async function GET(request: NextRequest) {
    try { const scope = await actor(request), day = request.nextUrl.searchParams.get('date') || philippineDate(); if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid planning date'); return NextResponse.json(await pageBudgetData(scope.user_id, day), { headers: { 'Cache-Control': 'no-store' } }); }
    catch (e) { return failure(e); }
}
export async function POST(request: NextRequest) {
    try { if (request.headers.get('origin') !== request.nextUrl.origin) throw Object.assign(new Error('Same-origin request required'), { status: 403 }); const scope = await actor(request), body = await request.json(); if (!['calculate', 'budget_save', 'page_weight'].includes(body.action)) throw new Error('Unknown budget action'); return NextResponse.json({ saved: await savePageBudget(scope.user_id, body) }, { headers: { 'Cache-Control': 'no-store' } }); }
    catch (e) { return failure(e); }
}
