import { expect, it } from 'vitest';
import { buildCreativeReport } from '../veo-creative-analytics';
const input = () => ({ from: '2026-11-01', to: '2026-11-02', as_of: '2026-11-07T00:00:00Z',
    ads: [{ ad_id: '1', ad_name: 'Video' }, { ad_id: '2', ad_name: 'Quiet' }],
    clients: [{ id: 'c', ad_id: '1', inquiry_at: '2026-11-01T01:00:00Z', stage: 'converted', converted_at: '2026-11-03T01:00:00Z', manual_fields: { industry: 'Food', business_type: 'Cafe' } }, { id: 'd', ad_id: '1', inquiry_at: '2026-11-02T01:00:00Z', stage: 'not_qualified' }],
    orders: [{ id: 'order', contact_id: 'c', currency: 'PHP', total_minor: 10000, paid_minor: 10000, closed_at: '2026-11-02', done_at: '2026-11-04', commission_minor: 4000 }],
    cash: [{ contact_id: 'c', currency: 'PHP', amount_minor: 4000 }, { contact_id: 'c', currency: 'PHP', amount_minor: 6000 }],
    spend: [{ ad_id: '1', spend_date: '2026-11-01', amount: 10, currency: 'PHP', frequency: 2, reach: 100, impressions: 200 }, { ad_id: '1', spend_date: '2026-11-02', amount: 20, currency: 'PHP', frequency: 3, reach: 100, impressions: 300 }],
    coverage: ['2026-11-01', '2026-11-02'].map(spend_date => ({ spend_date, currency: 'PHP', pht_aligned: true, report_complete: true })),
    delivery_history: [{ ad_id: '1', first_delivery_date: '2026-10-01', latest_delivery_date: '2026-11-02', delivery_days: 12 }] });
it('counts later conversions and deposit/balance once, with authoritative gross, salary, net and CPA', () => {
    const r = buildCreativeReport(input()), ad = r.ads[0];
    expect(ad).toMatchObject({ inquiries: 2, converted: 1, not_qualified: 1, conversion_rate: .5, paying_clients: 1, paid_orders: 1, done_orders: 1, mean_inquiry_to_conversion_hours: 48, daily_frequency_weighted_mean: 2.5, recorded_delivery_days: 12 });
    expect(ad.finance[0]).toMatchObject({ gross_minor: 10000, salary_minor: 4000, ad_spend_minor: 3000, net_minor: 3000, average_daily_spend_minor: 1500, average_order_minor: 10000, cost_per_purchase_minor: 3000, cost_per_acquisition_minor: 3000, net_roas: 2 });
    expect(r.daily.find((d: any) => d.ad_id === '1' && d.day === '2026-11-01')).toMatchObject({ converted: 1, inquiries: 1 });
    expect(ad.demographics.find(d => d.key === 'industry')?.rows).toEqual(expect.arrayContaining([{ label: 'Food', count: 1, percent: .5 }, { label: 'Unknown', count: 1, percent: .5 }]));
});
it('does not fabricate retained salary, complete cost coverage, zero-denominator CPA or whole-period unique frequency', () => {
    const data: any = input(); data.orders[0].commission_minor = null;
    expect(buildCreativeReport(data).ads[0].finance[0].net_minor).toBeNull();
    data.orders[0].commission_minor = 4000; data.coverage.pop();
    const f = buildCreativeReport(data).ads[0].finance[0]; expect(f.net_minor).toBeNull(); expect(f.cost_per_purchase_minor).toBeNull();
    const quiet = buildCreativeReport(input()).ads.find(a => a.ad_id === '2')!; expect(quiet.conversion_rate).toBeNull(); expect(quiet.running_calendar_days).toBeNull(); expect(quiet.daily_frequency_weighted_mean).toBeNull();
});
it('keeps mixed currencies separate and refuses net from unconverted financial mismatches', () => {
    const data: any = input(); data.cash.push({ contact_id: 'c', currency: 'USD', amount_minor: 2000 });
    const ad = buildCreativeReport(data).ads[0]; expect(ad.finance).toHaveLength(2); expect(ad.finance.every((f: any) => f.net_minor == null)).toBe(true);
});
