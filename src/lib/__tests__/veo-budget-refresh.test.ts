import { afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), read: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => m }));
vi.mock('@/lib/veo-report-read', () => ({ readVeoRpc: m.read }));
import { refreshPageBudgets, calculateVeoBudget } from '../veo-budget';
afterEach(() => { vi.clearAllMocks(); });
it('reads capacity once per tenant/day while preserving every authoritative budget write', async () => {
    const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const inputs = { day: 4, startingBudget: 2000, currentBudget: 2800, yesterdayCPA: 400, yesterdayResult: 'PROFIT' };
    const rows = Array.from({ length: 30 }, (_, i) => ({ tenant_id: 'tenant', team_id: 'team-' + i, page_id: 'page-' + i,
        work_date: day, currency: 'PHP', inputs }));
    const plans = rows.map(row => ({ team_id: row.team_id, page_id: row.page_id, active_workers: 5, quota: 10, full_capacity: 12 }));
    const lt = vi.fn();
    m.from.mockImplementation(table => {
        const q: any = { select: () => q, in: () => q, lt: (...args: any[]) => { lt(...args); return q; }, order: () => q,
            limit: async () => ({ data: rows, error: null }), eq: () => q, single: async () => ({ data: { owner_id: 'owner' }, error: null }) };
        return q;
    });
    m.read.mockResolvedValue({ data: { plans }, error: null }); m.rpc.mockResolvedValue({ data: {}, error: null });
    await refreshPageBudgets();
    expect(m.read).toHaveBeenCalledOnce();
    expect(m.from.mock.calls.filter(([table]) => table === 'veo_tenants')).toHaveLength(1);
    expect(lt).toHaveBeenCalledWith('checked_at', expect.any(String));
    expect(m.rpc).toHaveBeenCalledTimes(30);
    expect(m.rpc).toHaveBeenCalledWith('veo_budget_action', { p_actor: 'owner', p_action: 'budget_save', p_data: {
        team_id: 'team-0', page_id: 'page-0', work_date: day, currency: 'PHP', ...calculateVeoBudget(inputs, plans[0]),
        reason: 'Automatic reconciliation with current attendance and frozen worker capacity'
    } });
});
