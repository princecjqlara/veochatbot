import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { workspaceScope, philippineDate, uuid } from '@/lib/veo-workspace';
import { buildEmployeeProfile } from '@/lib/veo-employee-profile';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const validDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
const json = (body: any, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export async function GET(request: NextRequest) {
    try {
        const session = await getSessionFromRequest(request);
        if (!session?.user?.id) return json({ error: 'Sign in required' }, 401);
        const scope = await workspaceScope(session.user.id);
        if (!scope?.launch_at) return json({ error: 'Workspace access is inactive' }, 403);
        const q = request.nextUrl.searchParams, worker = q.get('worker_id') || (scope.role === 'member' ? scope.user_id : '');
        const page = q.get('page_id') || null, from = q.get('from') || philippineDate(), to = q.get('to') || philippineDate();
        if (!uuid(worker) || !validDay(from) || !validDay(to) || from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 92) return json({ error: 'Choose an employee and up to 93 valid Philippine dates' }, 400);
        if ((scope.role === 'member' && worker !== scope.user_id) || (page && (!uuid(page) || !scope.page_ids.includes(page)))) return json({ error: 'Employee or Page access denied' }, 403);
        const result = await getSupabaseAdmin().rpc('veo_employee_profile', { p_actor: scope.user_id, p_worker: worker, p_from: from, p_to: to, p_page: page });
        if (result.error) return json({ error: result.error.message }, result.error.code === '42501' ? 403 : 400);
        if (!result.data?.employee || !Array.isArray(result.data.days) || !result.data.summary) throw new Error('Employee profile data is unavailable');
        return json(buildEmployeeProfile(result.data));
    } catch (e: any) { return json({ error: e.message || 'Employee profile unavailable' }, 400); }
}
