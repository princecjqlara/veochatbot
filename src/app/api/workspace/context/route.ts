import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { workspaceScope, philippineDate } from '@/lib/veo-workspace';
import { readVeoRpc } from '@/lib/veo-report-read';
import { loadVeoAccountDirectory } from '@/lib/veo-account-directory';

export const dynamic = 'force-dynamic';
const reply = (data: any, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
export async function GET(request: NextRequest) {
    try {
        const session = await getSessionFromRequest(request);
        if (!session?.user?.id) return reply({ error: 'Sign in required' }, 401);
        const scope = await workspaceScope(session.user.id, request);
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
            data.accounts = await loadVeoAccountDirectory(db, scope, view === 'profile');
        }
        return reply(data);
    } catch { return reply({ error: 'Workspace context unavailable' }, 503); }
}
