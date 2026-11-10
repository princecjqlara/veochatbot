import { expect, it } from 'vitest';
import { loadVeoAccountDirectory } from '../veo-account-directory';
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
