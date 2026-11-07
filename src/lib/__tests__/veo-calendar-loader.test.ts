import { expect, it, vi } from 'vitest';
import { loadVeoCalendarInputs } from '../veo-calendar-loader';
function slice(p: string, from: string, day: string) { return { as_of: '2026-11-06T00:00:00Z', scope: {}, pages: [{ id: p }], leads: [{ id: p + from }], selected_clients: [{ id: p + day, inquiry_at: day + 'T00:00:00+08:00' }], orders: [{ order_key: p + ':same' }], cash: [{ contact_id: p, page_id: p, currency: 'PHP', source: 'workspace', paid_day: '2026-11-01', amount_minor: 20 }], spend: [], messages: [{ day: from, inbound: 1, answered: 1 }], page_plans: [], team_plans: [{ team_id: 'team', work_date: '2026-11-01' }], employees: [{ id: 'worker' }], message_coverage: [{ page_id: p }], peer_lag_hours: [24], missing_inquiry_dates: 4 }; }
it('merges all Pages with bounded requests, unique records and summed daily response counts', async () => {
    let running = 0, max = 0;
    const db = { rpc: vi.fn(async (_: string, args: any) => { max = Math.max(max, ++running); await new Promise(r => setTimeout(r, 2)); running--; return { data: slice(args.p_page, args.p_from, args.p_day) }; }) };
    const r = await loadVeoCalendarInputs(db, 'owner', ['p1', 'p2', 'p3', 'p4', 'p1'], '2026-11-01', '2026-11-06', '2026-11-05');
    expect(max).toBeLessThanOrEqual(2); expect(r.pages).toHaveLength(4); expect(r.leads).toHaveLength(4);
    expect(r.team_plans).toHaveLength(1); expect(r.employees).toHaveLength(1); expect(r.missing_inquiry_dates).toBe(16);
    expect(r.messages[0]).toMatchObject({ inbound: 4, answered: 4 }); expect(r.peer_lag_hours).toHaveLength(4);
});
it('bisects a timed-out date range and deduplicates financial facts while using only the chosen day’s cohort and reference sample', async () => {
    const db = { rpc: vi.fn(async (_: string, a: any) => a.p_from === '2026-11-01' && a.p_to === '2026-11-06' ? { error: { code: '57014' } } : { data: slice(a.p_page, a.p_from, a.p_day) }) };
    const r = await loadVeoCalendarInputs(db, 'owner', ['page'], '2026-11-01', '2026-11-06', '2026-11-05');
    expect(db.rpc).toHaveBeenCalledTimes(4); expect(r.completed_slices).toBe(2); expect(r.orders).toHaveLength(1); expect(r.cash).toHaveLength(1);
    expect(r.selected_clients).toHaveLength(1); expect(r.selected_clients[0].inquiry_at).toContain('2026-11-05');
    expect(r.missing_inquiry_dates).toBe(4); expect(r.peer_lag_hours).toHaveLength(1);
});
it('recovers a transient timeout on the original Page range before creating extra date slices', async () => {
    const db = { rpc: vi.fn().mockResolvedValueOnce({ error: { code: '57014' } }).mockImplementation(async (_: string, a: any) => ({ data: slice(a.p_page, a.p_from, a.p_day) })) };
    const r = await loadVeoCalendarInputs(db, 'owner', ['page'], '2026-11-01', '2026-11-06', '2026-11-05');
    expect(db.rpc).toHaveBeenCalledTimes(2); expect(r.completed_slices).toBe(1);
    expect(db.rpc.mock.calls[0][1]).toEqual(db.rpc.mock.calls[1][1]);
});
it('never returns partial totals after a Page failure or a one-day timeout', async () => {
    const db = { rpc: vi.fn(async (_: string, a: any) => a.p_page === 'bad' ? { error: { code: '42501' } } : { data: slice(a.p_page, a.p_from, a.p_day) }) };
    await expect(loadVeoCalendarInputs(db, 'owner', ['ok', 'bad'], '2026-11-01', '2026-11-02', '2026-11-01')).rejects.toMatchObject({ status: 403 });
    db.rpc.mockResolvedValue({ error: { code: '57014' } } as any);
    await expect(loadVeoCalendarInputs(db, 'owner', ['ok'], '2026-11-01', '2026-11-01', '2026-11-01')).rejects.toThrow('could not be completed');
});
