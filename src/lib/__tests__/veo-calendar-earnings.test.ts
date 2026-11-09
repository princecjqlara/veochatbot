import { expect, it } from 'vitest';
import { buildVeoCalendar } from '../veo-calendar-analytics';
const day = '2026-11-09', next = '2026-11-10';
function inputs(): any {
    return { as_of: next + 'T04:00:00Z', scope: { role: 'owner', launch_at: day + 'T00:00:00+08:00' }, pages: [{ id: 'page' }],
        leads: [], selected_clients: [], cash: [{ contact_id: 'client', currency: 'PHP', paid_day: day, amount_minor: 10000 }],
        orders: [{ order_key: 'one', contact_id: 'client', currency: 'PHP', total_minor: 12000, paid_minor: 10000,
            gross_before_refunds_minor: 12000, refunds_minor: 2000, commission_minor: 3500, done_at: day + 'T04:00:00Z', done_date: day }],
        created_orders: [{ order_key: 'invoice', created_date: day, currency: 'PHP', total_minor: 12000, balance_minor: 0 }],
        spend: [day, next].map(d => ({ page_id: 'page', spend_date: d, currency: 'PHP', amount_minor: d === day ? 1000 : 0, complete: true })),
        page_plans: [], team_plans: [], employees: [], messages: [], message_coverage: [], peer_lag_hours: [] };
}
it('reconciles gross, refunds and net across all elapsed days, including zero-sale days', () => {
    const r = buildVeoCalendar(inputs(), {}, '2026-11', day);
    expect(r.earnings).toMatchObject({ days: 2, from: day, to: next, provisional: true, includes_zero_sale_days: true, orders_created: 1 });
    expect(r.earnings.finance[0]).toMatchObject({ gross_before_refunds_minor: 12000, refunds_minor: 2000, gross_minor: 10000,
        salary_minor: 3500, ad_spend_minor: 1000, net_minor: 5500, average_gross_minor: 6000, average_net_minor: 2750, cost_complete_days: 2 });
    expect(r.days.filter(d => d.work_date >= day && d.work_date <= next).reduce((n, d) => n + d.finance[0].net_minor!, 0)).toBe(5500);
});
it('does not hide missing cost days or fabricate a net average', () => {
    const input = inputs(); input.spend.pop();
    const r = buildVeoCalendar(input, {}, '2026-11', day);
    expect(r.earnings.finance[0]).toMatchObject({ average_gross_minor: 6000, average_net_minor: null, net_minor: null, cost_missing_days: 1 });
});
it('handles losses, future months and the first launch day without dividing by zero', () => {
    const input = inputs(); input.spend[0].amount_minor = 20000;
    expect(buildVeoCalendar(input, {}, '2026-11', day).earnings.finance[0].average_net_minor).toBe(-6750);
    expect(buildVeoCalendar(input, {}, '2026-12', '2026-12-01').earnings).toMatchObject({ days: 0, finance: [], provisional: false });
    input.as_of = day + 'T04:00:00Z';
    expect(buildVeoCalendar(input, {}, '2026-11', day).earnings.days).toBe(1);
});
it('deduplicates invoices and keeps created order values separate from earnings and unknown balances', () => {
    const input = inputs(); input.created_orders.push(input.created_orders[0], { order_key: 'unlinked', created_date: day, currency: 'USD', total_minor: 9900, balance_minor: null });
    const r = buildVeoCalendar(input, {}, '2026-11', day);
    expect(r.selected.created_orders.count).toBe(2); expect(r.earnings.orders_created).toBe(2);
    expect(r.created_orders.finance.find(f => f.currency === 'USD')).toMatchObject({ value_minor: 9900, balance_unknown_orders: 1 });
    expect(r.earnings.finance.find(f => f.currency === 'USD')?.gross_before_refunds_minor).toBe(0);
});
