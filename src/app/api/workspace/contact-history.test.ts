import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), scope: vi.fn(), rpc: vi.fn(), from: vi.fn(), sellerFilter: [] as string[] }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => m }));
vi.mock('@/lib/veo-workspace', () => ({ workspaceScope: m.scope, philippineDate: (date = new Date()) => new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10), uuid: vi.fn(), createWorkspaceAccount: vi.fn(), workspaceAction: vi.fn(), passwordHash: vi.fn() }));
vi.mock('@/lib/veo-jaucian', () => ({ jaucianRead: vi.fn(), verifyWorkerMapping: vi.fn() }));
import { GET } from './route';
const read = () => GET(new NextRequest('https://veo.test/api/workspace?contact_id=contact'));
beforeEach(() => {
    m.session.mockResolvedValue({ user: { id: 'active' } });
    m.scope.mockResolvedValue({ user_id: 'active', role: 'manager', launch_at: '2026-11-05T00:00:00Z', page_ids: ['page'], worker_ids: ['active'] });
    m.rpc.mockImplementation(async (name: string) => ({ data: name === 'veo_profile_detail_access' ? { branch_worker_ids: ['active', 'former'] } : { payments: [
        { currency: 'PHP', amount_minor: 10000, verified_by: 'former', kind: 'full' },
        { currency: 'PHP', amount_minor: 90000, verified_by: 'outside', kind: 'full' },
        { currency: 'PHP', amount_minor: 10000, verified_by: 'former', kind: 'full', voided_at: '2026-11-06' }
    ] } }));
    m.from.mockImplementation((table: string) => {
        let data: any = table === 'contacts' ? { id: 'contact', page_id: 'page' } : table === 'veo_contact_details' ? { fields: {} } : table === 'veo_order_facts' ? [
            { id: 'current-order', seller_id: 'active', currency: 'PHP', paid_minor: 10000 }, { id: 'former-order', seller_id: 'former', currency: 'PHP', paid_minor: 20000 }, { id: 'private-order', seller_id: 'outside', currency: 'PHP', paid_minor: 90000 }
        ] : [];
        const chain: any = { select: () => chain, eq: () => chain, is: () => chain, order: () => chain, maybeSingle: () => chain,
            in: (key: string, values: string[]) => { if (table === 'veo_order_facts') { m.sellerFilter = values; data = data.filter((o: any) => values.includes(o[key])); } return chain; },
            then: (resolve: (value: any) => any) => Promise.resolve({ data }).then(resolve) };
        return chain;
    });
});
afterEach(() => { vi.clearAllMocks(); });
it('retains former branch sellers in compact history and lifetime value, excluding other branches and voids', async () => {
    const response = await read(), data = await response.json();
    expect(response.status).toBe(200); expect(m.sellerFilter).toEqual(['active', 'former']);
    expect(data.orders.map((o: any) => o.id)).toEqual(['current-order', 'former-order']); expect(data.lifetime_value).toEqual({ PHP: 40000 });
    expect(m.rpc).toHaveBeenCalledWith('veo_profile_detail_access', { p_actor: 'active', p_contact: 'contact' });
});
it('checks current authorization before reading financial history', async () => {
    m.rpc.mockResolvedValue({ error: { code: '42501' } });
    expect((await read()).status).toBe(403); expect(m.from.mock.calls.map(([table]) => table)).toEqual(['contacts']);
});
it('fails closed when the branch context cannot be loaded', async () => {
    m.rpc.mockResolvedValue({ data: {} }); expect((await read()).status).toBe(503);
    expect(m.from.mock.calls.map(([table]) => table)).toEqual(['contacts']);
});
