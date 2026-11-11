import { afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => m }));
import { connectedVeoTenant, jaucianRead, verifyWorkerMapping, veoDirectory } from '../veo-jaucian';
import { CJ_OWNER_USER_ID } from '@/config/veo-owner';
const tenant = '00000000-0000-4000-8000-000000000001', member = '00000000-0000-4000-8000-000000000002';
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function database(tables: Record<string, any[]>, errorTable?: string) {
    const calls: any[] = [];
    m.from.mockImplementation(table => {
        let rows = tables[table] || [];
        const q: any = { select: vi.fn((fields: string) => { calls.push([table, fields]); return q; }),
            eq: vi.fn((key: string, value: any) => { rows = rows.filter(r => r[key] === value); return q; }),
            in: vi.fn((key: string, values: any[]) => { rows = rows.filter(r => values.includes(r[key])); return q; }),
            gte: () => q, lte: () => q, order: () => q,
            maybeSingle: async () => ({ data: rows[0] || null, error: table === errorTable ? {} : null }),
            range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: table === errorTable ? {} : null }) };
        return q;
    });
    return calls;
}
it('binds the shared VEO directory to CJ’s launched tenant and never selects credentials or page tokens', async () => {
    const calls = database({ veo_tenants: [{ id: tenant, owner_id: CJ_OWNER_USER_ID, name: 'VEO', launch_at: '2026-11-05T00:00:00Z' }],
        veo_accounts: [{ user_id: member, tenant_id: tenant, active: true, role: 'member', parent_id: 'manager', telegram_username: 'declared' }, { user_id: 'manager', tenant_id: tenant, active: true, role: 'manager', parent_id: CJ_OWNER_USER_ID }, { user_id: CJ_OWNER_USER_ID, tenant_id: tenant, active: true, role: 'owner', parent_id: null }],
        users: [{ id: member, name: 'Worker', is_active: true }, { id: 'manager', is_active: true }, { id: CJ_OWNER_USER_ID, is_active: true }],
        veo_worker_mappings: [{ user_id: member, telegram_user_id: 42 }],
        pages: [{ id: 'page', name: 'VEO page', veo_tenant_id: tenant, veo_enabled: true }],
        user_pages: [member, 'manager', CJ_OWNER_USER_ID].map(user_id => ({ user_id, page_id: 'page' })), veo_attendance: [] });
    const data = await veoDirectory(tenant);
    expect(data.accounts[0]).toMatchObject({ name: 'Worker', telegram_user_id: 42, telegram_username_verified: false, page_ids: ['page'] });
    expect(data.commission_rule).toMatchObject({ qualified_rate: 40, default_rate: 35, team_override: false });
    expect(calls.every(([, fields]) => !/\*|password|token|email/.test(fields))).toBe(true);
    database({ veo_tenants: [{ id: tenant, owner_id: 'another-owner', launch_at: '2026-11-05T00:00:00Z' }] });
    await expect(connectedVeoTenant(tenant)).rejects.toMatchObject({ status: 403 });
});
it('fails closed when a directory source is unavailable', async () => {
    database({ veo_tenants: [{ id: tenant, owner_id: CJ_OWNER_USER_ID, launch_at: '2026-11-05T00:00:00Z' }] }, 'veo_accounts');
    await expect(veoDirectory(tenant)).rejects.toThrow('Workspace directory unavailable');
});
it('reports missing automatic scheduling and excludes disabled logins without claiming the workforce is configured', async () => {
    const tables = { veo_tenants: [{ id: tenant, owner_id: CJ_OWNER_USER_ID, launch_at: '2026-11-05T00:00:00Z' }],
        veo_accounts: [{ user_id: member, tenant_id: tenant, role: 'member', active: true }, { user_id: CJ_OWNER_USER_ID, tenant_id: tenant, role: 'owner', active: true }],
        users: [{ id: member, is_active: false }, { id: CJ_OWNER_USER_ID, is_active: true }],
        veo_telegram_sync_state: [] as any[] };
    database(tables);
    const missing = await veoDirectory(tenant);
    expect(missing.accounts).toHaveLength(1); expect(missing.account_coverage).toEqual({ enabled_accounts: 1, disabled_login_accounts: 1 }); expect(missing.telegram_sync.configured).toBe(false);
    tables.veo_telegram_sync_state.push({ tenant_id: tenant, last_sync_at: '2026-11-11T00:00:00Z', next_sync_at: '2026-11-11T00:05:00Z', last_error: null });
    expect((await veoDirectory(tenant)).telegram_sync).toMatchObject({ configured: true, last_sync_at: '2026-11-11T00:00:00Z' });
});
it('withholds a leader’s obsolete primary group after the branch team is remapped', async () => {
    const accounts = [{ user_id: 'leader', tenant_id: tenant, role: 'team_leader', active: true, parent_id: CJ_OWNER_USER_ID },
        { user_id: 'manager', tenant_id: tenant, role: 'manager', active: true, parent_id: 'leader' }];
    const tables = { veo_tenants: [{ id: tenant, owner_id: CJ_OWNER_USER_ID, launch_at: '2026-11-05T00:00:00Z' }], veo_accounts: accounts,
        users: accounts.map(a => ({ id: a.user_id, is_active: true })), veo_staff_telegram_groups: [{ user_id: 'leader', telegram_chat_id: -100123 }],
        veo_teams: [{ id: 'team', tenant_id: tenant, manager_id: 'manager', telegram_chat_id: -100123 }] };
    database(tables);
    expect((await veoDirectory(tenant)).accounts.find(a => a.user_id === 'leader')?.telegram_chat_id).toBe(-100123);
    tables.veo_teams[0].telegram_chat_id = -100456;
    expect((await veoDirectory(tenant)).accounts.find(a => a.user_id === 'leader')?.telegram_chat_id).toBeNull();
    tables.veo_staff_telegram_groups[0].telegram_chat_id = -100456;
    expect((await veoDirectory(tenant)).accounts.find(a => a.user_id === 'leader')?.telegram_chat_id).toBe(-100456);
});
it('reads Jaucian with server authentication and rejects redirects, foreign tenant data and outages', async () => {
    vi.stubEnv('VEO_JAUCIAN_URL', 'https://jaucian.example'); vi.stubEnv('VEO_JAUCIAN_SECRET', 'private-test-key');
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, tenant_id: tenant, groups: [] })));
    vi.stubGlobal('fetch', fetch);
    expect((await jaucianRead(tenant)).groups).toEqual([]);
    expect(fetch.mock.calls[0][0].origin).toBe('https://jaucian.example');
    expect(fetch.mock.calls[0][1]).toMatchObject({ cache: 'no-store', redirect: 'error', headers: { Authorization: 'Bearer private-test-key' } });
    fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, tenant_id: 'foreign' })));
    await expect(jaucianRead(tenant)).rejects.toThrow('Jaucian connection unavailable');
    fetch.mockRejectedValue(new Error('private upstream details'));
    await expect(jaucianRead(tenant)).rejects.toThrow('Jaucian connection unavailable; retry shortly');
});
it('checks current human membership in the worker’s own mapped team before accepting a numeric identity', async () => {
    database({ veo_accounts: [{ user_id: member, tenant_id: tenant, active: true, role: 'member', parent_id: 'manager' }],
        veo_teams: [{ tenant_id: tenant, manager_id: 'manager', telegram_chat_id: -100123 }] });
    vi.stubEnv('VEO_JAUCIAN_URL', 'https://jaucian.example'); vi.stubEnv('VEO_JAUCIAN_SECRET', 'test');
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, tenant_id: tenant, verified: true, chat_id: -100123, user_id: 42 })));
    vi.stubGlobal('fetch', fetch);
    expect(await verifyWorkerMapping(tenant, member, '42')).toMatchObject({ verified: true });
    expect(Object.fromEntries(fetch.mock.calls[0][0].searchParams)).toEqual({ resource: 'identity', chat_id: '-100123', user_id: '42', tenant_id: tenant });
    fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, tenant_id: tenant, verified: false, chat_id: -100123, user_id: 42 })));
    await expect(verifyWorkerMapping(tenant, member, 42)).rejects.toThrow('verification did not match');
    database({ veo_accounts: [{ user_id: member, tenant_id: tenant, active: true, role: 'member', parent_id: 'manager' }] });
    await expect(verifyWorkerMapping(tenant, member, 42)).rejects.toThrow('destination first');
    await expect(verifyWorkerMapping(tenant, member, 'username')).rejects.toMatchObject({ status: 400 });
});
