import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { workspaceScope, philippineDate, uuid } from '@/lib/veo-workspace';
import { calendarRange } from '@/lib/ad-calendar';
import { readVeoRpc } from '@/lib/veo-report-read';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;
const validDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
export async function GET(request: NextRequest) {
    try {
        const session = await getSessionFromRequest(request);
        if (!session?.user?.id) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
        const scope = await workspaceScope(session.user.id);
        if (!scope?.launch_at) return NextResponse.json({ error: 'Workspace access is inactive' }, { status: 403 });
        const q = request.nextUrl.searchParams, view = q.get('view'), page = q.get('page_id') || null;
        if (page && (!uuid(page) || !scope.page_ids.includes(page))) return NextResponse.json({ error: 'Page access denied' }, { status: 403 });
        let result;
        if (view === 'calendar') {
            if (!['owner', 'team_leader'].includes(scope.role)) return NextResponse.json({ error: 'Calendar access requires Owner or Team Leader' }, { status: 403 });
            const range = calendarRange(q.get('month') || philippineDate().slice(0, 7));
            result = await readVeoRpc(getSupabaseAdmin(), 'veo_calendar_finance', { p_actor: scope.user_id, p_from: range.days[0], p_to: range.days.at(-1), p_page: page });
        } else {
            const from = q.get('from') || philippineDate(), to = q.get('to') || philippineDate(), offset = Number(q.get('offset') || 0);
            const worker = scope.role === 'member' ? q.get('status') === 'released' ? null : scope.user_id : q.get('worker_id') || null;
            if (!validDay(from) || !validDay(to) || (worker && !uuid(worker)) || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid date or employee filter');
            result = await readVeoRpc(getSupabaseAdmin(), 'veo_operations', { p_actor: scope.user_id, p_from: from, p_to: to, p_page: page, p_worker: worker,
                p_status: q.get('status') || 'all', p_search: q.get('search') || '', p_offset: offset });
        }
        if (result.error) throw Object.assign(new Error('Performance report is temporarily unavailable. Retry shortly.'), { status: result.error.code === '42501' ? 403 : 503 });
        return NextResponse.json(result.data, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error: any) { return NextResponse.json({ error: error.message || 'Performance unavailable' }, { status: error.status || (error.code === 'DATABASE_UNAVAILABLE' ? 503 : 400), headers: { 'Cache-Control': 'no-store' } }); }
}
