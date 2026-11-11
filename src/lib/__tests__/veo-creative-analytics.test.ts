import { expect, it } from 'vitest';
import { buildCreativeReport } from '../veo-creative-analytics';
const input = () => ({ from: '2026-11-01', to: '2026-11-02', as_of: '2026-11-07T00:00:00Z',
    ads: [{ ad_id: '1', ad_name: 'Video' }, { ad_id: '2', ad_name: 'Quiet' }],
    clients: [{ id: 'c', ad_id: '1', inquiry_at: '2026-11-01T01:00:00Z', stage: 'converted', converted_at: '2026-11-03T01:00:00Z', manual_fields: { industry: 'Food', business_type: 'Cafe' } }, { id: 'd', ad_id: '1', inquiry_at: '2026-11-02T01:00:00Z', stage: 'not_qualified' }],
    orders: [{ id: 'order', contact_id: 'c', currency: 'PHP', total_minor: 10000, paid_minor: 10000, closed_at: '2026-11-02', done_at: '2026-11-04', commission_minor: 4000 }],
    cash: [{ contact_id: 'c', currency: 'PHP', amount_minor: 4000 }, { contact_id: 'c', currency: 'PHP', amount_minor: 6000 }],
    spend: [{ ad_id: '1', spend_date: '2026-11-01', amount: 10, currency: 'PHP', frequency: 2, reach: 100, impressions: 200,clicks:10,link_clicks:8,messaging_started:1,video_plays:50,video_thruplays:5,video_complete:1,pht_aligned:true,report_complete:true }, { ad_id: '1', spend_date: '2026-11-02', amount: 20, currency: 'PHP', frequency: 3, reach: 100, impressions: 300,clicks:20,link_clicks:12,messaging_started:2,video_plays:100,video_thruplays:10,video_complete:2,pht_aligned:true,report_complete:true }],
    coverage: ['2026-11-01', '2026-11-02'].map(spend_date => ({ spend_date, currency: 'PHP', pht_aligned: true, report_complete: true })),
    reconciled_spend: ['2026-11-01', '2026-11-02'].map(spend_date => ({spend_date,currency:'PHP',complete:true})),
    delivery_history: [{ ad_id: '1', first_delivery_date: '2026-10-01', latest_delivery_date: '2026-11-02', delivery_days: 12 }] });
it('counts later conversions and deposit/balance once, with authoritative gross, salary, net and CPA', () => {
    const r = buildCreativeReport(input()), ad = r.ads[0];
    expect(ad).toMatchObject({ inquiries: 2, converted: 1, not_qualified: 1, conversion_rate: .5, paying_clients: 1, paid_orders: 1, done_orders: 1, mean_inquiry_to_conversion_hours: 48, daily_frequency_weighted_mean: 2.5, recorded_delivery_days: 12 });
    expect(ad.finance[0]).toMatchObject({ gross_minor: 10000, salary_minor: 4000, ad_spend_minor: 3000, net_minor: 3000, average_daily_spend_minor: 1500, average_order_minor: 10000, cost_per_purchase_minor: 3000, cost_per_acquisition_minor: 3000, net_roas: 2 });
    expect(r.daily.find((d: any) => d.ad_id === '1' && d.day === '2026-11-01')).toMatchObject({ converted: 1, inquiries: 1 });
    expect(ad.demographics.find((d: any) => d.key === 'industry')?.rows).toEqual(expect.arrayContaining([{ label: 'Food', count: 1, percent: .5 }, { label: 'Unknown', count: 1, percent: .5 }]));
});
it('uses verified Done milestones within the approved tolerance and excludes reported-only Closed amounts from payers', () => {
    const data: any = input();data.orders[0].paid_minor = 9800;
    data.orders.push({ id: 'unlinked', contact_id: 'd', currency: 'PHP', total_minor: 0, paid_minor: 0, closed_at: '2026-11-02', done_at: null });
    const ad = buildCreativeReport(data).ads[0];expect(ad.done_orders).toBe(1);expect(ad.paying_clients).toBe(1);expect(ad.paid_orders).toBe(1);
});
it('does not fabricate retained salary, complete cost coverage, zero-denominator CPA or whole-period unique frequency', () => {
    const data: any = input(); data.orders[0].commission_minor = null;
    expect(buildCreativeReport(data).ads[0].finance[0].net_minor).toBeNull();
    data.orders[0].commission_minor = 4000; data.reconciled_spend.pop();
    const f = buildCreativeReport(data).ads[0].finance[0]; expect(f.net_minor).toBeNull(); expect(f.cost_per_purchase_minor).toBeNull();
    const quiet = buildCreativeReport(input()).ads.find(a => a.ad_id === '2')!; expect(quiet.conversion_rate).toBeNull(); expect(quiet.running_calendar_days).toBeNull(); expect(quiet.daily_frequency_weighted_mean).toBeNull();
});
it('distinguishes revenue ROAS, commission-adjusted ROAS and profit ROI, and uses weighted delivery totals',()=>{
    const ad=buildCreativeReport(input()).ads[0],f=ad.finance[0];
    expect(f.gross_roas).toBeCloseTo(10000/3000);expect(f.net_roas).toBe(2);expect(f.profit_roi).toBe(1);
    expect(f).toMatchObject({cpc_minor:100,cpm_minor:6000,cost_per_message_minor:1000,cost_per_thruplay_minor:200,cost_per_inquiry_minor:1500,cost_per_conversion_minor:3000});
    expect(ad).toMatchObject({ctr:0.06,link_ctr:0.04,video_completion_rate:0.02,impressions:500,clicks:30,video_plays:150});
});
it('rejects incomplete reconciliation and non-PHT or provisional daily rows even when old coverage flags say complete',()=>{
    for(const change of [(d:any)=>d.reconciled_spend[0].complete=false,(d:any)=>d.spend[0].pht_aligned=false,(d:any)=>d.spend[0].report_complete=false,(d:any)=>d.as_of='2026-11-02T01:00:00Z']){
        const data:any=input();change(data);const ad=buildCreativeReport(data).ads[0];expect(ad.finance[0].gross_roas).toBeNull();expect(ad.finance[0].net_minor).toBeNull();expect(ad.ctr).toBeNull();
    }
});
it('keeps unknown retained salary unknown and counts a verified payer without a workspace order',()=>{
    const data:any=input();data.cash.push({payment_key:'retained:1',financial_source:'retained',contact_id:'d',currency:'PHP',amount_minor:2000});
    const ad=buildCreativeReport(data).ads[0];expect(ad.paying_clients).toBe(2);expect(ad.finance[0]).toMatchObject({gross_minor:12000,salary_minor:null,net_minor:null,net_roas:null,cost_per_acquisition_minor:1500});expect(ad.finance[0].gross_roas).toBe(4);
});
it('deduplicates stable financial identities while preserving legitimate same-amount payments and scopes daily output to the chosen creative',()=>{
    const data:any=input();data.cash=[{payment_key:'workspace:1',contact_id:'c',currency:'PHP',amount_minor:5000},{payment_key:'workspace:2',contact_id:'c',currency:'PHP',amount_minor:5000}];data.cash.push({...data.cash[0]});data.orders.push({...data.orders[0]});
    const report=buildCreativeReport(data);expect(report.ads[0].finance[0].gross_minor).toBe(10000);expect(report.ads[0].paid_orders).toBe(1);expect(report.daily).toHaveLength(2);
    const chosen=buildCreativeReport({...data,selected_ad:'2'});expect(chosen.daily.every((row:any)=>row.ad_id==='2')).toBe(true);expect(chosen.ads).toHaveLength(2);
});
it('keeps mixed currencies separate and refuses net from unconverted financial mismatches', () => {
    const data: any = input(); data.cash.push({ contact_id: 'c', currency: 'USD', amount_minor: 2000 });
    const ad = buildCreativeReport(data).ads[0]; expect(ad.finance).toHaveLength(2); expect(ad.finance.every((f: any) => f.net_minor == null)).toBe(true);
});
