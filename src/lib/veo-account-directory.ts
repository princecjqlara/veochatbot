import { fetchAllSupabaseRows, SUPABASE_IN_FILTER_BATCH_SIZE } from './supabase-pagination';
import { requestDeadline } from './request-deadline';
import type { WorkspaceScope } from './veo-workspace';

export function staffLoginReadiness(accounts: any[]) {
    const staff = accounts.filter(a => a.active !== false && a.role !== 'owner');
    return { workers: staff.length, enabled: staff.filter(a => a.is_active === true).length,
        disabled: staff.filter(a => a.is_active === false).length, unknown: staff.filter(a => a.is_active == null).length };
}

/** Only the already-authorized planning roster is queried; no credentials leave storage. */
export async function planningLoginReadiness(db: any, plans: any[]) {
    const ids = [...new Set<string>(plans.flatMap(plan => (plan.workers || []).map((worker: any) => worker.user_id)))];
    const rows: any[] = [];
    for (let i = 0; i < ids.length; i += SUPABASE_IN_FILTER_BATCH_SIZE) rows.push(...await fetchAllSupabaseRows<any>(
        db.from('users').select('id,is_active').in('id', ids.slice(i, i + SUPABASE_IN_FILTER_BATCH_SIZE)).order('id')));
    const states = new Map(rows.map(row => [row.id, row.is_active]));
    return staffLoginReadiness(ids.map(id => ({ role: 'member', is_active: states.get(id) ?? null })));
}

/** Complete, live branch directory. Do not calculate unrelated financial reports. */
export async function loadVeoAccountDirectory(db: any, scope: WorkspaceScope, personal = false) {
    const ids = personal ? [scope.user_id] : [...new Set([scope.user_id, ...scope.worker_ids])];
    return requestDeadline(async signal => {
        const all = (query: any) => fetchAllSupabaseRows<any>(typeof query.abortSignal === 'function' ? query.abortSignal(signal) : query);
        async function batches(values: string[], read: (batch: string[]) => any) {
            const rows: any[] = [];
            for (let i = 0; i < values.length; i += SUPABASE_IN_FILTER_BATCH_SIZE) rows.push(...await all(read(values.slice(i, i + SUPABASE_IN_FILTER_BATCH_SIZE))));
            return rows;
        }
        const accounts = await batches(ids, batch => db.from('veo_accounts').select('user_id,role,parent_id,active,telegram_username,telegram_profile_completed_at').eq('tenant_id', scope.tenant_id).in('user_id', batch).order('user_id'));
        if (!accounts.length) throw Error('Workspace staff list unavailable');
        const returned = accounts.map(a => a.user_id);
        const [users, pages] = await Promise.all([
            batches(returned, batch => db.from('users').select('id,name,email,is_active').in('id', batch).order('id')),
            scope.page_ids.length ? batches(returned, batch => db.from('user_pages').select('user_id,page_id').in('user_id', batch).order('user_id').order('page_id')) : Promise.resolve([])
        ]);
        const identities = new Map(users.map(u => [u.id, u]));
        if (accounts.some(a => !identities.has(a.user_id))) throw Error('Workspace staff identities unavailable');
        const grants = new Map<string, string[]>();
        const allowed = new Set(scope.page_ids);
        for (const p of pages) if (allowed.has(p.page_id)) { const list = grants.get(p.user_id) || []; list.push(p.page_id); grants.set(p.user_id, list); }
        return accounts.map(a => ({ ...a, ...identities.get(a.user_id), id: a.user_id, page_ids: grants.get(a.user_id) || [] })).sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.id.localeCompare(b.id));
    }, 12000).catch(() => { throw Object.assign(Error('Complete account directory is temporarily unavailable'), { status: 503, code: 'DATABASE_UNAVAILABLE' }); });
}
