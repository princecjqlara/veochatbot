import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { workspaceScope, philippineDate, uuid } from '@/lib/veo-workspace';
import { getSupabaseAdmin } from '@/lib/supabase';
import { calendarRange } from '@/lib/ad-calendar';
import { buildVeoCalendar } from '@/lib/veo-calendar-analytics';
import { loadVeoCalendarInputs, loadVeoCalendarDetails } from '@/lib/veo-calendar-loader';
import { createCalendarCache } from '@/lib/veo-calendar-cache';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
const monthCache = createCalendarCache<{ input: any; finance: any }>(30000);
const detailCache = createCalendarCache<any>(15000, 24);
export async function GET(request: NextRequest) {
    try {
        const session = await getSessionFromRequest(request);
        if (!session?.user?.id) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
        const scope = await workspaceScope(session.user.id, request);
        if (!scope?.launch_at || !['owner', 'team_leader'].includes(scope.role)) return NextResponse.json({ error: 'Calendar requires Owner or Team Leader access' }, { status: 403 });
        const q = request.nextUrl.searchParams, month = q.get('month') || philippineDate().slice(0, 7), page = q.get('page_id') || null;
        let range: ReturnType<typeof calendarRange>;
        try { range = calendarRange(month); }
        catch { return NextResponse.json({ error: 'Choose a valid calendar month' }, { status: 400 }); }
        const day = q.get('day') || (range.today.startsWith(month) ? range.today : range.days[0]);
        if (!range.days.includes(day)) throw Object.assign(new Error('Choose a date in the selected month'), { status: 400 });
        if (page && (!uuid(page) || !scope.page_ids.includes(page))) return NextResponse.json({ error: 'Page access denied' }, { status: 403 });
        const db = getSupabaseAdmin();
        const scopeKey = JSON.stringify([scope.tenant_id, scope.user_id, scope.role, scope.launch_at,
            [...scope.page_ids].sort(), [...(scope.worker_ids || [])].sort(), month, page, range.today]);
        const refresh = q.get('refresh') === '1';
        const launchDay = philippineDate(new Date(scope.launch_at));
        const monthly = await monthCache(scopeKey, async () => {
          if (range.days.includes(range.today)) {
            const prepared = await db.rpc('veo_calendar_prepare', { p_actor: scope.user_id });
            if (prepared.error) throw Object.assign(new Error('Today’s calendar planning is temporarily unavailable'), { status: 503 });
          }
        const from = range.days[0] > launchDay ? range.days[0] : launchDay;
        const to = range.days.at(-1)! < range.today ? range.days.at(-1)! : range.today;
        const [input, finance] = await Promise.all([loadVeoCalendarInputs(db, scope.user_id, page ? [page] : scope.page_ids, range.days[0], range.days.at(-1)!, null),
            from > to ? Promise.resolve({ data: { days: [] }, error: null }) : db.rpc('veo_finance_days', { p_actor: scope.user_id, p_from: from, p_to: to, p_page: page })]);
        if (finance.error) throw Object.assign(new Error('Calendar salary could not be completed. Retry shortly.'), { status: finance.error.code === '42501' ? 403 : 503 });
        return { input, finance: { salary_days: finance.data?.days || [] } };
        }, refresh);
        const details = await detailCache(scopeKey + ':' + monthly.input.as_of + ':' + day,
            () => loadVeoCalendarDetails(db, scope.user_id, page ? [page] : scope.page_ids, day), refresh);
        return NextResponse.json(buildVeoCalendar({ ...monthly.input, ...details }, monthly.finance, month, day, page), { headers: { 'Cache-Control': 'no-store' } });
    } catch (e: any) { return NextResponse.json({ error: e.message || 'Calendar unavailable' }, { status: e.status || 503, headers: { 'Cache-Control': 'no-store' } }); }
}
