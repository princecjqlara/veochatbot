import { expect, it } from 'vitest';
import { loadVeoAccountDirectory, planningLoginReadiness, staffLoginReadiness } from '../veo-account-directory';
const scope = { user_id: 'self', tenant_id: 'tenant', role: 'owner' as const, page_ids: ['allowed'], worker_ids: ['self', 'worker'], launch_at: '2026-11-09' };
function database(rows: Record<string, any[]>, failTable?: string) {
    const reads: any[] = [];
    return { reads, from(table: string) {
        const filters: Array<(r: any) => boolean> = [], q: any = {
            select: () => q, order: () => q, abortSignal: () => q,
            eq: (key: string, value: string) => { filters.push(r => r[key] === value);return q; },
            in: (key: string, values: string[]) => { expect(values.length).toBeLessThanOrEqual(100);filters.push(r => values.includes(r[key]));return q; },
            range: async (from: number, to: number) => { reads.push({ table, from });return table === failTable ? { error: { message: 'offline' } } : { data: (rows[table] || []).filter(r => filters.every(f => f(r))).slice(from, to + 1) }; }
        };return q;
    } };
}
it('reads every membership beyond the API row cap while keeping other Pages and tenants private', async () => {
    const db = database({ veo_accounts: [{ user_id: 'self', tenant_id: 'tenant' }, { user_id: 'worker', tenant_id: 'tenant' }, { user_id: 'other', tenant_id: 'another' }], users: [{ id: 'self', name: 'Self' }, { id: 'worker', name: 'Worker' }], user_pages: [...Array.from({ length: 1201 }, (_, i) => ({ user_id: i === 1200 ? 'worker' : 'self', page_id: 'allowed' })), { user_id: 'worker', page_id: 'forbidden' }] });
    const accounts = await loadVeoAccountDirectory(db, scope);
    expect(accounts).toHaveLength(2);expect(accounts.find(a => a.id === 'worker')?.page_ids).toEqual(['allowed']);
    expect(db.reads.some(r => r.table === 'user_pages' && r.from === 1000)).toBe(true);
});
it('fails the complete directory when identities or any source are unavailable', async () => {
    const rows = { veo_accounts: [{ user_id: 'self', tenant_id: 'tenant' }], users: [{ id: 'self' }] };
    await expect(loadVeoAccountDirectory(database(rows, 'user_pages'), scope)).rejects.toMatchObject({ status: 503 });
    await expect(loadVeoAccountDirectory(database({ ...rows, users: [] }), scope)).rejects.toMatchObject({ status: 503 });
});
it('keeps personal profile reads restricted to the actor', async () => {
    const db = database({ veo_accounts: [{ user_id: 'self', tenant_id: 'tenant' }, { user_id: 'worker', tenant_id: 'tenant' }], users: [{ id: 'self' }, { id: 'worker' }] });
    expect((await loadVeoAccountDirectory(db, scope, true)).map(a => a.id)).toEqual(['self']);
});
it('keeps missing login evidence unknown and excludes the Owner and departed accounts from staff setup counts', () => {
    expect(staffLoginReadiness([{ role: 'owner', is_active: true }, { role: 'member', active: false, is_active: false },
        { role: 'manager', active: true, is_active: true }, { role: 'member', active: true, is_active: false }, { role: 'team_leader', active: true }]))
        .toEqual({ workers: 3, enabled: 1, disabled: 1, unknown: 1 });
});
it('deduplicates the authorized planning roster across Pages and never counts an unrelated user', async () => {
    const db = database({ users: [{ id: 'one', is_active: true }, { id: 'two', is_active: false }, { id: 'unrelated', is_active: true }] });
    const plans = [{ workers: [{ user_id: 'one' }, { user_id: 'two' }] }, { workers: [{ user_id: 'one' }, { user_id: 'missing' }] }];
    expect(await planningLoginReadiness(db, plans)).toEqual({ workers: 3, enabled: 1, disabled: 1, unknown: 1 });
    await expect(planningLoginReadiness(database({}, 'users'), plans)).rejects.toThrow();
    const empty = database({});expect(await planningLoginReadiness(empty, [])).toEqual({ workers: 0, enabled: 0, disabled: 0, unknown: 0 });expect(empty.reads).toHaveLength(0);
});
