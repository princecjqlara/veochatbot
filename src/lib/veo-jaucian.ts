import { getSupabaseAdmin } from './supabase';
import { CJ_OWNER_USER_ID } from '@/config/veo-owner';
import { philippineDate, uuid } from './veo-workspace';

export const commissionRule = { qualified_rate: 40, default_rate: 35, qualification: 'both_personal_closed_and_done_targets', timezone: 'Asia/Manila', team_override: false };
const unavailable = (message: string, status = 503) => Object.assign(new Error(message), { status });

export async function connectedVeoTenant(tenant: string, db?: ReturnType<typeof getSupabaseAdmin>) {
    if (!uuid(tenant)) throw unavailable('Invalid tenant', 400);
    const result = await (db || getSupabaseAdmin()).from('veo_tenants').select('id,name,owner_id,launch_at').eq('id', tenant).eq('owner_id', CJ_OWNER_USER_ID).maybeSingle();
    if (result.error) throw unavailable('Tenant connection unavailable');
    if (!result.data?.launch_at) throw unavailable('Tenant is not connected', 403);
    return result.data;
}

// Only the two authenticated servers can read this directory. The financial
// ledger stays in VEO; reports and eligible submissions are shared separately.
export async function veoDirectory(tenant: string, db = getSupabaseAdmin()) {
    const connection = await connectedVeoTenant(tenant, db);
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
    const [accounts, teams, pages, ancestry, groupLinks, catalog] = await Promise.all([
        read(() => db.from('veo_accounts').select('user_id,role,parent_id,telegram_username,telegram_profile_completed_at').eq('tenant_id', tenant).eq('active', true).order('user_id')),
        read(() => db.from('veo_teams').select('id,name,manager_id,telegram_chat_id,telegram_thread_id,telegram_groups_managed').eq('tenant_id', tenant).order('id')),
        read(() => db.from('pages').select('id,name').eq('veo_tenant_id', tenant).eq('veo_enabled', true).order('id')),
        read(() => db.from('veo_accounts').select('user_id,parent_id').eq('tenant_id', tenant).order('user_id')),
        read(() => db.from('veo_team_telegram_groups').select('team_id,chat_id,thread_id').eq('tenant_id', tenant).order('team_id').order('chat_id')),
        read(() => db.from('veo_telegram_groups').select('chat_id,active').eq('tenant_id', tenant).order('chat_id'))
    ]);
    const users: any[] = [], mappings: any[] = [], attendance: any[] = [], grants: any[] = [], groups: any[] = [];
    const memberships: any[] = [], routes: any[] = [];
    for (let offset = 0; offset < teams.length; offset += 200) routes.push(...await read(() => db.from('veo_team_telegram_pages').select('team_id,page_id,chat_id').in('team_id', teams.slice(offset, offset + 200).map(t => t.id)).order('team_id').order('page_id')));
    const day = philippineDate(), tomorrow = philippineDate(new Date(Date.now() + 86400000));
    // Bound IN clauses and read all rows rather than accepting PostgREST's
    // default row cap as a complete workforce or page-assignment list.
    for (let offset = 0; offset < accounts.length; offset += 200) {
        const ids = accounts.slice(offset, offset + 200).map(a => a.user_id);
        const batch = await Promise.all([
            read(() => db.from('users').select('id,name,is_active').in('id', ids).order('id')),
            read(() => db.from('veo_worker_mappings').select('user_id,telegram_user_id').in('user_id', ids).order('user_id')),
            read(() => db.from('veo_attendance').select('user_id,work_date,active,updated_at').in('user_id', ids).gte('work_date', day).lte('work_date', tomorrow).order('user_id').order('work_date')),
            read(() => db.from('user_pages').select('user_id,page_id').in('user_id', ids).in('page_id', pages.map(p => p.id)).order('user_id').order('page_id')),
            read(() => db.from('veo_staff_telegram_groups').select('user_id,telegram_chat_id').in('user_id', ids).order('user_id')),
            read(() => db.from('veo_telegram_memberships').select('user_id,chat_id,telegram_user_id,verified_at').in('user_id', ids).order('user_id').order('chat_id'))
        ]);
        users.push(...batch[0]); mappings.push(...batch[1]); attendance.push(...batch[2]); grants.push(...batch[3]); groups.push(...batch[4]);
        memberships.push(...batch[5]);
    }
    const names = new Map(users.map(u => [u.id, u])), tg = new Map(mappings.map(m => [m.user_id, m.telegram_user_id]));
    const active = accounts.filter(a => names.get(a.user_id)?.is_active);
    const activeIds = new Set(active.map(a => a.user_id));
    const currentTeams = teams.filter(t => activeIds.has(t.manager_id) || active.some(a => a.parent_id === t.manager_id));
    function permittedPages(user: string) {
        let permitted = pages.map(p => p.id);const visited = new Set<string>();
        while (user) { if (visited.has(user) || !activeIds.has(user)) return [];visited.add(user);permitted = permitted.filter(id => grants.some(g => g.user_id === user && g.page_id === id));user = ancestry.find(a => a.user_id === user)?.parent_id; }
        return permitted;
    }
    const currentLinks = groupLinks.filter(l => currentTeams.some(t => t.id === l.team_id) && catalog.some(g => String(g.chat_id) === String(l.chat_id) && g.active))
        .map(l => ({ ...l, page_ids: routes.filter(r => r.team_id === l.team_id && String(r.chat_id) === String(l.chat_id) && permittedPages(currentTeams.find(t => t.id === l.team_id).manager_id).includes(r.page_id)).map(r => r.page_id) })).filter(l => l.page_ids.length);
    function memberGroups(account: any) {
        return memberships.filter(m => m.user_id === account.user_id && String(m.telegram_user_id) === String(tg.get(account.user_id)) && currentLinks.some(l => String(l.chat_id) === String(m.chat_id) && l.page_ids.some((p: string) => permittedPages(account.user_id).includes(p)) &&
            (account.role === 'owner' || account.role === 'team_leader' && inBranch(currentTeams.find(t => t.id === l.team_id).manager_id, account.user_id) || currentTeams.find(t => t.id === l.team_id).manager_id === (account.role === 'manager' ? account.user_id : account.parent_id))))
            .map(m => ({ chat_id: m.chat_id, verified_at: m.verified_at, page_ids: [...new Set(currentLinks.filter(l => String(l.chat_id) === String(m.chat_id) && (account.role === 'owner' || account.role === 'team_leader' && inBranch(currentTeams.find(t => t.id === l.team_id).manager_id, account.user_id) || currentTeams.find(t => t.id === l.team_id).manager_id === (account.role === 'manager' ? account.user_id : account.parent_id))).flatMap(l => l.page_ids))].filter(p => permittedPages(account.user_id).includes(p)) }));
    }
    function inBranch(manager: string, leader: string) {
        const visited = new Set<string>();
        while (manager && !visited.has(manager)) { if (manager === leader) return true; visited.add(manager); manager = ancestry.find(a => a.user_id === manager)?.parent_id; }
        return false;
    }
    function currentGroup(account: any) {
        const linked = memberGroups(account), team = currentTeams.find(t => t.manager_id === (account.role === 'manager' ? account.user_id : account.parent_id));
        if (linked.length || team?.telegram_groups_managed) { const primary = groups.find(g => g.user_id === account.user_id)?.telegram_chat_id;return linked.find(g => String(g.chat_id) === String(primary))?.chat_id || linked[0]?.chat_id || null; }
        if (account.role !== 'team_leader') return currentTeams.find(t => t.manager_id === (account.role === 'manager' ? account.user_id : account.parent_id))?.telegram_chat_id || null;
        const chat = groups.find(g => g.user_id === account.user_id)?.telegram_chat_id;
        return chat && currentTeams.some(t => String(t.telegram_chat_id) === String(chat) && inBranch(t.manager_id, account.user_id)) ? chat : null;
    }
    return { ok: true, tenant_id: tenant, name: connection.name, launch_at: connection.launch_at,
        checked_at: new Date().toISOString(), source: 'VEO database', read_only: true, commission_rule: commissionRule, telegram_workflow_version: 3,
        accounts: active.map(a => ({ ...a, name: names.get(a.user_id)?.name || 'Unknown name',
            telegram_user_id: tg.get(a.user_id) || null, telegram_username_verified: false,
            telegram_chat_id: currentGroup(a),
            telegram_groups: memberGroups(a), page_ids: permittedPages(a.user_id) })),
        teams: currentTeams.map(t => ({ ...t, leader_id: active.find(a => a.user_id === t.manager_id)?.role === 'team_leader' ? t.manager_id : ancestry.find(a => a.user_id === t.manager_id)?.parent_id || null, telegram_groups: currentLinks.filter(l => l.team_id === t.id) })), pages,
        attendance: attendance.filter(a => activeIds.has(a.user_id)) };
}

export async function jaucianRead(tenant: string, params: Record<string, string> = {}) {
    if (!process.env.VEO_JAUCIAN_SECRET || !process.env.VEO_JAUCIAN_URL) throw unavailable('Jaucian connection is not configured');
    const url = new URL('/api/veo/workspace', process.env.VEO_JAUCIAN_URL);
    if (url.protocol !== 'https:' || url.username || url.password) throw unavailable('Secure Jaucian URL required');
    url.search = new URLSearchParams({ ...params, tenant_id: tenant }).toString();
    try {
        const response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.VEO_JAUCIAN_SECRET}`, Accept: 'application/json' },
            cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(['workforce', 'automatic'].includes(params.resource) ? 60000 : 25000) });
        const body = await response.json();
        if (!response.ok || !body.ok || body.tenant_id !== tenant) throw unavailable(response.status === 400 ? 'Telegram identity must be a current human member of the mapped team group' : 'Jaucian connection unavailable', response.status === 400 ? 400 : 503);
        return body;
    } catch (error: any) {
        if (error.status) throw error;
        throw unavailable('Jaucian connection unavailable; retry shortly');
    }
}

export async function verifyWorkerMapping(tenant: string, userId: unknown, telegramId: unknown, requestedChat?: unknown) {
    if (!uuid(userId) || !/^[1-9]\d{0,15}$/.test(String(telegramId)) || !Number.isSafeInteger(Number(telegramId))) throw unavailable('Select a worker and a numeric human Telegram identity', 400);
    const db = getSupabaseAdmin();
    const account = await db.from('veo_accounts').select('user_id,role,parent_id').eq('tenant_id', tenant).eq('user_id', userId).eq('active', true).maybeSingle();
    if (account.error) throw unavailable('Worker identity unavailable');
    if (!account.data || !['manager', 'member', 'team_leader'].includes(account.data.role)) throw unavailable('Select an active staff account', 400);
    let team;
    if (account.data.role === 'team_leader') {
        const children = await db.from('veo_accounts').select('user_id').eq('tenant_id', tenant).eq('parent_id', userId).eq('role', 'manager');
        if (children.error || !requestedChat) throw unavailable('Select an approved mapped group in this leader’s branch', 400);
        team = await db.from('veo_teams').select('telegram_chat_id').eq('tenant_id', tenant).in('manager_id', [userId, ...(children.data || []).map(c => c.user_id)]).eq('telegram_chat_id', Number(requestedChat)).limit(1).maybeSingle();
    } else team = await db.from('veo_teams').select('telegram_chat_id').eq('tenant_id', tenant).eq('manager_id', account.data.role === 'manager' ? userId : account.data.parent_id).maybeSingle();
    if (team.error) throw unavailable('Team destination unavailable');
    if (!team.data?.telegram_chat_id) throw unavailable('Map this worker’s team destination first', 400);
    const identity = await jaucianRead(tenant, { resource: 'identity', chat_id: String(team.data.telegram_chat_id), user_id: String(telegramId) });
    if (identity.verified !== true || Number(identity.user_id) !== Number(telegramId) || Number(identity.chat_id) !== Number(team.data.telegram_chat_id)) throw unavailable('Telegram membership verification did not match', 400);
    return identity;
}
