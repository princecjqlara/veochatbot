import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { workspaceScope, philippineDate, uuid } from '@/lib/veo-workspace';
import { getSupabaseAdmin } from '@/lib/supabase';
import { readVeoRpc } from '@/lib/veo-report-read';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const pending = new Map<string, Promise<any>>();
const reply = (data: any, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
export async function GET(request: NextRequest) {
    try {
        const session = await getSessionFromRequest(request);
        if (!session?.user?.id) return reply({ error: 'Sign in required' }, 401);
        const scope = await workspaceScope(session.user.id, request);
        if (!scope?.launch_at || !['owner', 'team_leader'].includes(scope.role)) return reply({ error: 'Business Insights requires Owner or Team Leader access' }, 403);
        const q = request.nextUrl.searchParams, today = philippineDate(), launch = philippineDate(new Date(scope.launch_at));
        const recent = philippineDate(new Date(Date.now() - 29 * 86400000));
        const from = q.get('from') || (launch > recent ? launch : recent), to = q.get('to') || today, page = q.get('page_id') || null;
        const valid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
        if (!valid(from) || !valid(to) || from < launch || to > today || to < from || (Date.parse(to) - Date.parse(from)) / 86400000 > 92) return reply({ error: 'Choose up to 93 Philippine dates from workspace launch through today' }, 400);
        if (page && (!uuid(page) || !scope.page_ids.includes(page))) return reply({ error: 'Page access denied' }, 403);
        const key = JSON.stringify([session.user.id, scope.tenant_id, scope.role, [...scope.page_ids].sort(), [...(scope.worker_ids || [])].sort(), from, to, page]);
        let read = pending.get(key);
        if (!read) {
            if (pending.size >= 2) return reply({ error: 'Reports are busy. Try again shortly.' }, 503);
            read = readVeoRpc(getSupabaseAdmin(), 'veo_business_insights', { p_actor: session.user.id, p_from: from, p_to: to, p_page: page }, 12000).finally(() => pending.delete(key));
            pending.set(key, read);
        }
        const result = await read;
        if (result.error) return reply({ error: result.error.code === '42501' ? result.error.message : 'Business Insights is temporarily unavailable. Refresh to retry.' }, result.error.code === '42501' ? 403 : 503);
        if (result.data?.version !== 1 || !Array.isArray(result.data.money) || !Array.isArray(result.data.pages) || !result.data.readiness || !result.data.period || !result.data.backlog) throw Error('Incomplete report');
        return reply(result.data);
    } catch (error: any) { return reply({ error: error.status === 403 ? error.message : 'Business Insights is temporarily unavailable. Refresh to retry.' }, error.status === 403 ? 403 : 503); }
}
