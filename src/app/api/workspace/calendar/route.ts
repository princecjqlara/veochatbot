import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { workspaceScope, philippineDate, uuid } from '@/lib/veo-workspace';
import { getSupabaseAdmin } from '@/lib/supabase';
import { calendarRange } from '@/lib/ad-calendar';
import { buildVeoCalendar } from '@/lib/veo-calendar-analytics';
import { loadVeoCalendarInputs } from '@/lib/veo-calendar-loader';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
export async function GET(request: NextRequest) {
    try {
        const session = await getSessionFromRequest(request);
        if (!session?.user?.id) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
        const scope = await workspaceScope(session.user.id);
        if (!scope?.launch_at || !['owner', 'team_leader'].includes(scope.role)) return NextResponse.json({ error: 'Calendar requires Owner or Team Leader access' }, { status: 403 });
        const q = request.nextUrl.searchParams, month = q.get('month') || philippineDate().slice(0, 7), range = calendarRange(month), page = q.get('page_id') || null;
        const day = q.get('day') || (range.today.startsWith(month) ? range.today : range.days[0]);
        if (!range.days.includes(day)) throw new Error('Choose a date in the selected month');
        if (page && (!uuid(page) || !scope.page_ids.includes(page))) return NextResponse.json({ error: 'Page access denied' }, { status: 403 });
        const args = { p_actor: scope.user_id, p_from: range.days[0], p_to: range.days.at(-1), p_page: page };
        const db = getSupabaseAdmin();
        const beforeLaunch = range.days.at(-1)! < philippineDate(new Date(scope.launch_at));
        const [input, finance] = await Promise.all([loadVeoCalendarInputs(db, scope.user_id, page ? [page] : scope.page_ids, range.days[0], range.days.at(-1)!, day),
            beforeLaunch ? Promise.resolve({ data: { salary_days: [] }, error: null }) : db.rpc('veo_calendar_finance', args)]);
        if (finance.error) throw Object.assign(new Error('Calendar salary could not be completed. Retry shortly.'), { status: finance.error.code === '42501' ? 403 : 503 });
        return NextResponse.json(buildVeoCalendar(input, finance.data, month, day, page), { headers: { 'Cache-Control': 'no-store' } });
    } catch (e: any) { return NextResponse.json({ error: e.message || 'Calendar unavailable' }, { status: e.status || 400, headers: { 'Cache-Control': 'no-store' } }); }
}
