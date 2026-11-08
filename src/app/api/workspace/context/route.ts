import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { workspaceScope, philippineDate } from '@/lib/veo-workspace';
import { readVeoRpc } from '@/lib/veo-report-read';

export const dynamic = 'force-dynamic';
const reply = (data: any, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
export async function GET(request: NextRequest) {
    try {
        const session = await getSessionFromRequest(request);
        if (!session?.user?.id) return reply({ error: 'Sign in required' }, 401);
        const scope = await workspaceScope(session.user.id);
        if (!scope?.launch_at) return reply({ error: 'Workspace unavailable' }, 403);
        const q = request.nextUrl.searchParams, view = q.get('view') || '', day = q.get('date') || philippineDate();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < philippineDate(new Date(scope.launch_at)) || day > philippineDate()) return reply({ error: 'Choose a Philippine work date from launch through today' }, 400);
        const data: any = { scope, accounts: [], tomorrow: [], orders: [], salary: [], submissions: [], sync: [], teams: [], capacity: null };
        const db = getSupabaseAdmin();
        if (view === 'capacity') {
            const [capacity, salary] = await Promise.all([
                readVeoRpc(db, 'veo_team_capacity', { p_actor: scope.user_id, p_day: day }),
                readVeoRpc(db, 'veo_salary', { p_actor: scope.user_id, p_day: day })
            ]);
            if (capacity.error || salary.error) return reply({ error: 'Capacity is temporarily unavailable' }, 503);
            data.capacity = capacity.data;data.salary = [salary.data];
        }
        const accounts = q.get('accounts') === '1';
        if (accounts) {
            const ids = view === 'profile' ? [scope.user_id] : [...new Set([scope.user_id, ...scope.worker_ids])];
            const rows = await db.from('veo_accounts').select('user_id,role,parent_id,active,telegram_username,telegram_profile_completed_at').in('user_id', ids).limit(500);
            if (rows.error) return reply({ error: 'Workspace staff list unavailable' }, 503);
            const users = rows.data?.length ? await db.from('users').select('id,name,email').in('id', rows.data.map((r: any) => r.user_id)).limit(500) : { data: [], error: null };
            if (users.error) return reply({ error: 'Workspace staff list unavailable' }, 503);
            const pages = rows.data?.length ? await db.from('user_pages').select('user_id,page_id').in('user_id', rows.data.map((r: any) => r.user_id)).in('page_id', scope.page_ids).limit(2000) : { data: [], error: null };
            if (pages.error) return reply({ error: 'Workspace Page access list unavailable' }, 503);
            data.accounts = (rows.data || []).map((a: any) => ({ ...a, id: a.user_id, ...(users.data || []).find((u: any) => u.id === a.user_id), page_ids: (pages.data || []).filter((p: any) => p.user_id === a.user_id).map((p: any) => p.page_id) }));
        }
        return reply(data);
    } catch { return reply({ error: 'Workspace context unavailable' }, 503); }
}
