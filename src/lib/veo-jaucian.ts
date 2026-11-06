import { getSupabaseAdmin } from './supabase';
import { CJ_OWNER_USER_ID } from '@/config/veo-owner';
import { philippineDate, uuid } from './veo-workspace';

export const commissionRule = { qualified_rate: 40, default_rate: 35, qualification: 'both_personal_closed_and_done_targets', timezone: 'Asia/Manila', team_override: false };
const unavailable = (message: string, status = 503) => Object.assign(new Error(message), { status });

export async function connectedVeoTenant(tenant: string) {
    if (!uuid(tenant)) throw unavailable('Invalid tenant', 400);
    const result = await getSupabaseAdmin().from('veo_tenants').select('id,name,owner_id,launch_at').eq('id', tenant).eq('owner_id', CJ_OWNER_USER_ID).maybeSingle();
    if (result.error) throw unavailable('Tenant connection unavailable');
    if (!result.data?.launch_at) throw unavailable('Tenant is not connected', 403);
    return result.data;
}

// Only the two authenticated servers can read this directory. The financial
// ledger stays in VEO; reports and eligible submissions are shared separately.
export async function veoDirectory(tenant: string) {
    const db = getSupabaseAdmin(), connection = await connectedVeoTenant(tenant);
    async function read(query: () => any) {
        const rows: any[] = [];
        for (let offset = 0; offset <= 10000; offset += 500) {
            const result = await query().range(offset, offset + 499);
            if (result.error) throw unavailable('Workspace directory unavailable');
            rows.push(...(result.data || []));
            if ((result.data || []).length < 500) return rows;
        }
        throw unavailable('Workspace directory exceeds its safe read limit');
    }
    const [accounts, teams, pages] = await Promise.all([
        read(() => db.from('veo_accounts').select('user_id,role,parent_id,telegram_username,telegram_profile_completed_at').eq('tenant_id', tenant).eq('active', true).order('user_id')),
        read(() => db.from('veo_teams').select('id,name,manager_id,telegram_chat_id,telegram_thread_id').eq('tenant_id', tenant).order('id')),
        read(() => db.from('pages').select('id,name').eq('veo_tenant_id', tenant).eq('veo_enabled', true).order('id'))
    ]);
    const users: any[] = [], mappings: any[] = [], attendance: any[] = [], grants: any[] = [];
    const day = philippineDate(), tomorrow = philippineDate(new Date(Date.now() + 86400000));
    // Bound IN clauses and read all rows rather than accepting PostgREST's
    // default row cap as a complete workforce or page-assignment list.
    for (let offset = 0; offset < accounts.length; offset += 200) {
        const ids = accounts.slice(offset, offset + 200).map(a => a.user_id);
        const batch = await Promise.all([
            read(() => db.from('users').select('id,name,is_active').in('id', ids).order('id')),
            read(() => db.from('veo_worker_mappings').select('user_id,telegram_user_id').in('user_id', ids).order('user_id')),
            read(() => db.from('veo_attendance').select('user_id,work_date,active,updated_at').in('user_id', ids).gte('work_date', day).lte('work_date', tomorrow).order('user_id').order('work_date')),
            read(() => db.from('user_pages').select('user_id,page_id').in('user_id', ids).in('page_id', pages.map(p => p.id)).order('user_id').order('page_id'))
        ]);
        users.push(...batch[0]); mappings.push(...batch[1]); attendance.push(...batch[2]); grants.push(...batch[3]);
    }
    const names = new Map(users.map(u => [u.id, u])), tg = new Map(mappings.map(m => [m.user_id, m.telegram_user_id]));
    const active = accounts.filter(a => names.get(a.user_id)?.is_active);
    const activeIds = new Set(active.map(a => a.user_id));
    return { ok: true, tenant_id: tenant, name: connection.name, launch_at: connection.launch_at,
        checked_at: new Date().toISOString(), source: 'VEO database', read_only: true, commission_rule: commissionRule,
        accounts: active.map(a => ({ ...a, name: names.get(a.user_id)?.name || 'Unknown name',
            telegram_user_id: tg.get(a.user_id) || null, telegram_username_verified: false,
            page_ids: grants.filter(g => g.user_id === a.user_id).map(g => g.page_id) })),
        teams: teams.filter(t => activeIds.has(t.manager_id)), pages,
        attendance: attendance.filter(a => activeIds.has(a.user_id)) };
}

export async function jaucianRead(tenant: string, params: Record<string, string> = {}) {
    if (!process.env.VEO_JAUCIAN_SECRET || !process.env.VEO_JAUCIAN_URL) throw unavailable('Jaucian connection is not configured');
    const url = new URL('/api/veo/workspace', process.env.VEO_JAUCIAN_URL);
    if (url.protocol !== 'https:' || url.username || url.password) throw unavailable('Secure Jaucian URL required');
    url.search = new URLSearchParams({ ...params, tenant_id: tenant }).toString();
    try {
        const response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.VEO_JAUCIAN_SECRET}`, Accept: 'application/json' },
            cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(25000) });
        const body = await response.json();
        if (!response.ok || !body.ok || body.tenant_id !== tenant) throw unavailable(response.status === 400 ? 'Telegram identity must be a current human member of the mapped team group' : 'Jaucian connection unavailable', response.status === 400 ? 400 : 503);
        return body;
    } catch (error: any) {
        if (error.status) throw error;
        throw unavailable('Jaucian connection unavailable; retry shortly');
    }
}

export async function verifyWorkerMapping(tenant: string, userId: unknown, telegramId: unknown) {
    if (!uuid(userId) || !/^[1-9]\d{0,15}$/.test(String(telegramId)) || !Number.isSafeInteger(Number(telegramId))) throw unavailable('Select a worker and a numeric human Telegram identity', 400);
    const db = getSupabaseAdmin();
    const account = await db.from('veo_accounts').select('user_id,role,parent_id').eq('tenant_id', tenant).eq('user_id', userId).eq('active', true).maybeSingle();
    if (account.error) throw unavailable('Worker identity unavailable');
    if (!account.data || !['manager', 'member'].includes(account.data.role)) throw unavailable('Select a selling manager or member', 400);
    const team = await db.from('veo_teams').select('telegram_chat_id').eq('tenant_id', tenant)
        .eq('manager_id', account.data.role === 'manager' ? userId : account.data.parent_id).maybeSingle();
    if (team.error) throw unavailable('Team destination unavailable');
    if (!team.data?.telegram_chat_id) throw unavailable('Map this worker’s team destination first', 400);
    const identity = await jaucianRead(tenant, { resource: 'identity', chat_id: String(team.data.telegram_chat_id), user_id: String(telegramId) });
    if (identity.verified !== true || Number(identity.user_id) !== Number(telegramId) || Number(identity.chat_id) !== Number(team.data.telegram_chat_id)) throw unavailable('Telegram membership verification did not match', 400);
    return identity;
}
