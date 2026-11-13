import { describe, expect, it } from 'vitest';
import { buildVeoCalendar, demographics, objections, cohortProjection, veoCalendarShade, veoCalendarTile, veoCalendarResult, inquiryDayConversions } from '../veo-calendar-analytics';
const first = '2026-11-01T04:00:00Z', now = '2026-11-08T04:00:00Z';
const lead = (id: string, stage = 'converted') => ({ id, page_id: 'page', name: id, stage, inquiry_at: first, converted_at: stage === 'converted' ? '2026-11-03T04:00:00Z' : null });
function inputs() { return { as_of: now, scope: { role: 'owner', launch_at: '2026-10-30T00:00:00Z' }, pages: [{ id: 'page', name: 'VEO' }], leads: [lead('one'), lead('two', 'qualified')], selected_clients: [lead('one'), lead('two', 'qualified')], orders: [{ order_key: 'order', contact_id: 'one', seller_id: 'seller', currency: 'PHP', paid_minor: 10000, total_minor: 10000, commission_minor: 3500, financial_source: 'workspace', closed_at: '2026-11-03T04:00:00Z', closed_date: '2026-11-03', done_at: '2026-11-05T04:00:00Z', done_date: '2026-11-05' }], cash: [{ contact_id: 'one', currency: 'PHP', amount_minor: 3000, paid_day: '2026-11-03' }, { contact_id: 'one', currency: 'PHP', amount_minor: 7000, paid_day: '2026-11-05' }], spend: [{ page_id: 'page', currency: 'PHP', spend_date: '2026-11-01', amount_minor: 2000, complete: true }, { page_id: 'page', currency: 'PHP', spend_date: '2026-11-05', amount_minor: 1000, complete: true }], peer_lag_hours: [], messages: [], message_coverage: [], page_plans: [], team_plans: [], employees: [{ id: 'seller', name: 'Seller' }], missing_inquiry_dates: 3 }; }
describe('restored daily activity and eventual inquiry cohort analytics', () => {
    it('counts order-free Closed events without treating their reported amount as verified revenue or paid customers', () => {
        const data: any = inputs();data.orders.push({ ...data.orders[0], order_key: 'closed-only', contact_id: 'two', paid_minor: 0, total_minor: 0, done_at: null, done_date: null });
        const r = buildVeoCalendar(data, { salary_days: [] }, '2026-11', '2026-11-01');
        expect(r.days.find(d => d.work_date === '2026-11-03')?.closed).toBe(2);expect(r.selected.cohort.paid_customers).toBe(1);expect(r.selected.cohort.finance[0].received_minor).toBe(10000);
    });
    it('credits later payments to the inquiry cohort and counts CD/DD only on their actual financial dates', () => {
        const r = buildVeoCalendar(inputs(), { salary_days: [] }, '2026-11', '2026-11-01');
        expect(r.days.find(d => d.work_date === '2026-11-01')).toMatchObject({ inquiries: 2, closed: 0, done: 0, cohort_converted: 1, converted_later: 1 });
        expect(r.days.find(d => d.work_date === '2026-11-03')?.closed).toBe(1);
        expect(r.days.find(d => d.work_date === '2026-11-05')?.finance[0]).toMatchObject({ gross_minor: 10000, salary_minor: 3500, ad_spend_minor: 1000, net_minor: 5500 });
        expect(r.selected.cohort.finance[0]).toMatchObject({ received_minor: 10000, salary_minor: 3500, ad_spend_minor: 2000, net_minor: 4500, acquisition_cost_minor: 2000, gross_roas: 5, mean_order_minor: 10000, median_order_minor: 10000 });
        expect(r.selected.touchpoints.map(t => t.converted)).toEqual([0, 1, 1, 1]);
        expect(r.selected.timing[1]).toMatchObject({ mean_hours: 48, median_hours: 48 });
        expect(r.selected.timing[2]).toMatchObject({ mean_hours: 96, median_hours: 96 });
    });
    it('does not invent historical salaries, response rates, staffing or quotas', () => {
        const input = inputs(); input.orders[0].commission_minor = null as any; input.orders[0].financial_source = 'retained'; input.scope.launch_at = '2026-11-06T00:00:00Z';
        const r = buildVeoCalendar(input, { salary_days: [] }, '2026-11', '2026-11-05');
        expect(r.selected.finance[0]).toMatchObject({ salary_minor: null, net_minor: null });
        expect(r.selected.response).toMatchObject({ rate: null, inbound: null, coverage_complete: false });
        expect(r.selected.staffing.available).toBeNull(); expect(r.selected.quota.done.target).toBeNull();
        expect(r.selected.quota.done.actual).toBe(0); expect(r.selected.done).toBe(1);
    });
    it('reports quota surpassed separately from daily attendance unknowns and preserves Page-filtered targets', () => {
        const input: any = inputs(); input.team_plans = [{ work_date: '2026-11-05', quota: 1, participating: 1, unknown: 2, workers: 3, capacity: 3 }];
        input.orders.push({ ...input.orders[0], order_key: 'two', contact_id: 'two' });
        input.messages = [{ day: '2026-11-05', inbound: 4, answered: 3 }]; input.message_coverage = [{ page_id: 'page', capture_from: '2026-10-30T00:00:00Z' }];
        const r = buildVeoCalendar(input, { salary_days: [] }, '2026-11', '2026-11-05');
        expect(r.selected.quota.done).toMatchObject({ status: 'surpassed', percent: 2, surplus: 1, remaining: 0 });
        expect(r.selected.staffing).toMatchObject({ available: 1, unknown: 2, roster: 3 }); expect(r.selected.response.rate).toBe(.75);
    });
    it('does not combine mismatched currencies into ROAS or net profit', () => {
        const input: any = inputs(); input.orders[0].currency = 'USD'; input.cash.forEach((c: any) => c.currency = 'USD');
        const r = buildVeoCalendar(input, { salary_days: [] }, '2026-11', '2026-11-01');
        expect(r.selected.cohort.finance.every((f: any) => f.net_minor == null && f.gross_roas == null)).toBe(true);
    });
    it('blocks financial return ratios when any Page spend is partial, missing or still provisional', () => {
        const input: any = inputs(); input.spend[0].complete = false;
        const partial = buildVeoCalendar(input, {}, '2026-11', '2026-11-01').selected.cohort.finance[0];
        expect(partial).toMatchObject({ ad_spend_minor: 2000, spend_complete: false, gross_roas: null, net_minor: null, acquisition_cost_minor: null, cost_per_inquiry_minor: null });
        input.spend[0].complete = true; input.pages.push({ id: 'missing', name: 'Missing Page' });
        expect(buildVeoCalendar(input, {}, '2026-11', '2026-11-01').selected.cohort.finance[0].gross_roas).toBeNull();
    });
    it('shows verified cash separately without counting unfinished orders as completed-sales profit', () => {
        const input: any = inputs(); input.leads[0].stage = 'order_created'; input.leads[0].converted_at = null;
        input.orders[0].closed_at = null; input.orders[0].done_at = null; input.orders[0].done_date = null;
        input.cash.forEach((p: any) => p.source = 'workspace');
        const r = buildVeoCalendar(input, { salary_days: [] }, '2026-11', '2026-11-01');
        expect(r.selected.cohort.paid_customers).toBe(0); expect(r.selected.cohort.finance[0].received_minor).toBe(10000);expect(r.selected.cohort.finance[0].gross_minor).toBe(0);expect(r.selected.cohort.finance[0].net_minor).toBe(-2000);
        expect(r.days.find(d => d.work_date === '2026-11-05')?.finance[0].received_minor).toBe(7000);
    });
});
it('shades actual net profit or loss by one currency and calculates net ROAS after salary', () => {
    const input = inputs();
    const salary = [{ user_id: 'seller', work_date: '2026-11-05', done: 1, rate: 35, totals: [{ currency: 'PHP', gross_minor: 10000, commission_minor: 3500 }] }];
    const r = buildVeoCalendar(input, { salary_days: salary }, '2026-11', '2026-11-05');
    expect(r.selected.finance[0]).toMatchObject({ net_minor: 5500, net_roas: 6.5 });
    expect(veoCalendarShade(r.selected, 'net', 'PHP')).toBe(5500);
    expect(veoCalendarShade(r.selected, 'net', 'USD')).toBeNull();
    expect(r.selected.salary_rates[0]).toMatchObject({ rate: 35, workers: 1 });
    const inquiry = r.days.find(d => d.work_date === '2026-11-01')!;
    expect(veoCalendarShade(inquiry, 'net', 'PHP')).toBe(-2000);
    expect(veoCalendarShade(inquiry, 'cohort_net', 'PHP')).toBe(4500);
    expect(inquiry.cohort_finance[0].net_roas).toBe(3.25);
    input.spend[1].amount_minor = 10000;
    expect(buildVeoCalendar(input, { salary_days: salary }, '2026-11', '2026-11-05').selected.finance[0]).toMatchObject({ net_minor: -3500, net_roas: .65 });
});
it('keeps mixed salary rates distinct and refuses unknown salary, zero-spend ROAS or incomplete costs', () => {
    const input: any = inputs();
    input.orders.push({ ...input.orders[0], order_key: 'two', seller_id: 'second', commission_minor: 4000 });
    const salary = [35, 40].map((rate, i) => ({ user_id: `seller-${i}`, work_date: '2026-11-05', done: 1, rate, totals: [{ currency: 'PHP', commission_minor: rate * 100, gross_minor: 10000 }] }));
    expect(buildVeoCalendar(input, { salary_days: salary }, '2026-11', '2026-11-05').selected.salary_rates.map(r => r.rate)).toEqual([35, 40]);
    input.orders[0].commission_minor = null;
    const unknown = buildVeoCalendar(input, {}, '2026-11', '2026-11-05').selected;
    expect(unknown.finance[0].net_roas).toBeNull(); expect(veoCalendarShade(unknown, 'net', 'PHP')).toBeNull();
    input.orders[0].commission_minor = 3500; input.spend[1].amount_minor = 0;
    expect(buildVeoCalendar(input, {}, '2026-11', '2026-11-05').selected.finance[0].net_roas).toBeNull();
    input.spend[1].complete = false;
    expect(veoCalendarShade(buildVeoCalendar(input, {}, '2026-11', '2026-11-05').selected, 'net', 'PHP')).toBeNull();
});
it('uses recorded demographics with explicit unknown percentages and manual correction priority', () => {
    const rows = demographics([{ manual_fields: { gender: '', age: '22' }, saved_fields: { gender: 'Male', city: 'Manila' } }, { manual_fields: { gender: 'Female', age: '34' } }]);
    expect(rows.find(r => r.dimension === 'Gender')?.rows.find(r => r.label === 'Unknown')).toMatchObject({ count: 1, percent: .5 });
    expect(rows.find(r => r.dimension === 'Location')?.known).toBe(1);
    expect(rows.find(r => r.dimension === 'Age')?.known).toBe(2);
});
it('deduplicates supported objections per client and excludes unsupported extracted facts', () => {
    const proof = [{ message_id: 'm', quote: 'mahal' }];
    const r = objections([{ id: 'one', profile_as_of: now, objections: [{ value: 'mahal', evidence: proof }, { value: 'price', evidence: proof }, { value: 'scam', evidence: [] }] }, { id: 'two' }]);
    expect(r.rows).toEqual([{ label: 'Price / budget', clients: 1, percent: .5 }]);
});
it('requires mature peer coverage for projections and never treats a closed window as a lifetime limit', () => {
    expect(cohortProjection([lead('new', 'new')], [], Date.parse(now)).status).toBe('insufficient_history');
    const peers = [...Array(40).fill(null), ...Array(10).fill(300)];
    const estimate = cohortProjection([lead('new', 'new')], peers, Date.parse(now));
    expect(estimate.status).toBe('estimated'); expect(estimate.additional).toBeCloseTo(.2); expect(estimate.lower).toBeLessThan(.2); expect(estimate.upper).toBeGreaterThan(.2);
    expect(cohortProjection([lead('old', 'new')], peers, Date.parse('2026-12-30')).status).toBe('window_complete');
});

it('shows provisional net at zero spend without manufacturing a ROAS or treating missing costs as zero',()=>{
 const data:any=inputs();data.spend.find((s:any)=>s.spend_date==='2026-11-05').complete=false;data.spend.find((s:any)=>s.spend_date==='2026-11-05').provisional=true;data.spend.find((s:any)=>s.spend_date==='2026-11-05').amount_minor=0;
 let result=buildVeoCalendar(data,{salary_days:[]},'2026-11','2026-11-05');expect(result.selected.finance[0]).toMatchObject({net_minor:6500,provisional:true,spend_complete:false,gross_roas:null,financial_blocker:'zero_spend'});
 data.spend.find((s:any)=>s.spend_date==='2026-11-05').provisional=false;result=buildVeoCalendar(data,{salary_days:[]},'2026-11','2026-11-05');expect(result.selected.finance[0]).toMatchObject({net_minor:null,spend_usable:false,financial_blocker:'spend_missing'});
});

it('updates acquisition-date color after later completions and preserves the separate daily result',()=>{
 const data:any=inputs();const before=JSON.parse(JSON.stringify(data));before.orders=[];before.cash=[];
 const early=buildVeoCalendar(before,{},'2026-11','2026-11-01');
 const later=buildVeoCalendar(data,{},'2026-11','2026-11-01');
 expect(veoCalendarShade(early.selected,'cohort_net','PHP')).toBe(-2000);
 expect(veoCalendarShade(later.selected,'cohort_net','PHP')).toBe(4500);
 expect(veoCalendarShade(later.selected,'net','PHP')).toBe(-2000);
 expect(veoCalendarShade({...later.selected,future:true},'cohort_net','PHP')).toBeNull();
});

it('attributes tile sales, closed and done counts to first inquiry even when the sale occurs on a later date',()=>{
 const r=buildVeoCalendar(inputs(),{},'2026-11','2026-11-01');
 const acquired=r.days.find(d=>d.work_date==='2026-11-01')!;
 const completed=r.days.find(d=>d.work_date==='2026-11-05')!;
 expect(veoCalendarTile(acquired,'cohort_net')).toMatchObject({inquiry:true,closed:1,done:1,finance:[{received_minor:10000,net_minor:4500}]});
 expect(veoCalendarShade(acquired,'closed','PHP')).toBe(1);
 expect(veoCalendarShade(acquired,'done','PHP')).toBe(1);
 expect(veoCalendarTile(completed,'cohort_net')).toMatchObject({closed:0,done:0});
 expect(veoCalendarTile(completed,'net')).toMatchObject({inquiry:false,done:1,finance:[{gross_minor:10000,net_minor:5500}]});
 expect(acquired.closed).toBe(0);expect(completed.done).toBe(1);
});

it('does not invent missing salary before launch when there are no completed orders or retained payments',()=>{
 const data:any=inputs();data.scope.launch_at='2026-11-09T00:00:00Z';data.orders=[];data.cash=[];
 const report=buildVeoCalendar(data,{},'2026-11','2026-11-01');
 expect(report.selected.cohort.finance[0]).toMatchObject({salary_minor:0,received_minor:0,ad_spend_minor:2000,net_minor:-2000});
 expect(veoCalendarShade(report.selected,'cohort_net','PHP')).toBe(-2000);
});
it('leaves verified zero-spend dates uncolored while retaining their profitable sales and net values',()=>{
 const data:any=inputs();data.spend[0].amount_minor=0;
 const report=buildVeoCalendar(data,{},'2026-11','2026-11-01');
 expect(report.selected.cohort.finance[0]).toMatchObject({received_minor:10000,salary_minor:3500,net_minor:6500});
 expect(veoCalendarShade(report.selected,'cohort_net','PHP')).toBe(0);
 data.spend[0].complete=false;
 expect(veoCalendarShade(buildVeoCalendar(data,{},'2026-11','2026-11-01').selected,'cohort_net','PHP')).toBeNull();
});

it('does not turn a pending deposit into profit before the order is completed',()=>{
 const data:any=inputs();data.orders[0].done_at=null;data.orders[0].done_date=null;data.orders[0].paid_minor=3000;data.orders[0].commission_minor=0;data.cash=[data.cash[0]];
 const f=buildVeoCalendar(data,{},'2026-11','2026-11-01').selected.cohort.finance[0];
 expect(f).toMatchObject({received_minor:3000,gross_minor:0,salary_minor:0,net_minor:-2000,cash_net_minor:1000,ad_return_minor:-2000});
 expect(veoCalendarResult(f)).toMatchObject({label:'Ad result: loss',amount:2000,noAds:false});
});
it('labels zero-spend completed client earnings separately from ad performance',()=>{
 const data:any=inputs();data.spend[0].amount_minor=0;
 const f=buildVeoCalendar(data,{},'2026-11','2026-11-01').selected.cohort.finance[0];
 expect(f).toMatchObject({received_minor:10000,gross_minor:10000,earnings_after_commission_minor:6500,ad_return_minor:null});
 expect(veoCalendarResult(f)).toEqual({label:'Client earnings after commission (no ads)',amount:6500,noAds:true});
 expect(veoCalendarShade({cohort_finance:[f]},'cohort_net','PHP')).toBe(0);
});

it('keeps normal daily computation on completion and payment dates independently of inquiry-date results',()=>{
 const report=buildVeoCalendar(inputs(),{},'2026-11','2026-11-01');
 const inquiry=report.days.find(d=>d.work_date==='2026-11-01')!;
 const paid=report.days.find(d=>d.work_date==='2026-11-05')!;
 expect(veoCalendarTile(inquiry,'cohort_net')).toMatchObject({done:1,finance:[{gross_minor:10000,net_minor:4500}]});
 expect(veoCalendarTile(inquiry,'net')).toMatchObject({done:0,finance:[{gross_minor:0,net_minor:-2000}]});
 expect(veoCalendarTile(paid,'net')).toMatchObject({done:1,finance:[{gross_minor:10000,received_minor:7000,salary_minor:3500,net_minor:5500}]});
 expect(veoCalendarShade(inquiry,'daily_done','PHP')).toBe(0);expect(veoCalendarShade(paid,'daily_done','PHP')).toBe(1);
 expect(veoCalendarResult(paid.finance[0],false)).toMatchObject({label:'Daily net profit',amount:5500});
});

it('counts same-day inquiry conversions once per client and keeps later conversions separate',()=>{
 const clients=['a','b','c','d'].map(id=>({id,inquiry_at:'2026-11-01T01:00:00Z'}));
 const orders=[{contact_id:'a',closed_at:'2026-11-01T02:00:00Z',done_at:'2026-11-01T03:00:00Z'},{contact_id:'a',closed_at:'2026-11-01T04:00:00Z',done_at:'2026-11-01T05:00:00Z'},{contact_id:'b',closed_at:'2026-11-01T02:00:00Z',done_at:'2026-11-02T02:00:00Z'},{contact_id:'c',closed_at:'2026-11-02T02:00:00Z',done_at:'2026-11-03T02:00:00Z'}];
 const s=inquiryDayConversions(clients,orders,'2026-11-01',Date.parse('2026-11-04T00:00:00Z'));
 expect(s).toMatchObject({inquiries:4,same_day_closed:{clients:2,rate:.5},same_day_done:{clients:1,rate:.25},same_day_both:{clients:1,rate:.25},eventually_closed:{clients:3,rate:.75},eventually_done:{clients:3,rate:.75},closed_later:{clients:1},done_later:{clients:2}});
});
it('uses Philippine midnight instead of a rolling 24 hours and excludes earlier clients and future outcomes',()=>{
 const clients=[{id:'late',inquiry_at:'2026-11-01T15:55:00Z'},{id:'old',inquiry_at:'2026-10-31T01:00:00Z'}];
 const orders=[{contact_id:'late',closed_at:'2026-11-01T16:05:00Z',done_at:'2026-11-01T17:00:00Z'},{contact_id:'old',closed_at:'2026-11-01T02:00:00Z',done_at:'2026-11-01T03:00:00Z'}];
 const s=inquiryDayConversions(clients,orders,'2026-11-01',Date.parse('2026-11-02T00:00:00Z'));
 expect(s).toMatchObject({inquiries:1,same_day_closed:{clients:0,rate:0},same_day_done:{clients:0},same_day_both:{clients:0},eventually_done:{clients:1}});
 const current=inquiryDayConversions(clients,orders,'2026-11-01',Date.parse('2026-11-01T15:59:00Z'));
 expect(current.eventually_done.clients).toBe(0);expect(current.provisional).toBe(true);
});
it('requires both milestones on the same order, preserves a zero-inquiry denominator and publishes rates in each calendar day',()=>{
 const s=inquiryDayConversions([{id:'a',inquiry_at:'2026-11-01T01:00:00Z'}],[{contact_id:'a',closed_at:'2026-11-01T02:00:00Z',done_at:null},{contact_id:'a',closed_at:null,done_at:'2026-11-01T03:00:00Z'}],'2026-11-01',Date.parse(now));
 expect(s.same_day_closed.clients).toBe(1);expect(s.same_day_done.clients).toBe(1);expect(s.same_day_both.clients).toBe(0);
 expect(inquiryDayConversions([],[],'2026-11-01',Date.parse(now)).same_day_closed.rate).toBeNull();
 expect(buildVeoCalendar(inputs(),{},'2026-11','2026-11-01').selected.inquiry_conversion).toMatchObject({inquiries:2,same_day_closed:{clients:0},eventually_closed:{clients:1,rate:.5}});
});
