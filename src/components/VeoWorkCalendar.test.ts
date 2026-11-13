import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('next/link', () => ({ default: ({ children }: any) => children }));
vi.mock('./VeoAdsConnection', () => ({ default: () => null }));
vi.mock('@/lib/use-hourly-report-refresh', () => ({ useHourlyReportRefresh: () => {} }));
import Calendar, { InquiryConversionSummary } from './VeoWorkCalendar';
import { buildVeoCalendar } from '@/lib/veo-calendar-analytics';
let view: ReactTestRenderer;
const text = (v: any): string => Array.isArray(v) ? v.map(text).join('') : typeof v === 'string' || typeof v === 'number' ? String(v) : (v?.children || []).map(text).join('');
afterEach(async () => { if (view) await act(async () => view.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('renders inquiry-date sales and clear red/green colors even when daily transactions have different results', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-14T00:00:00Z'));
    const day = (date: string, net: number) => ({ work_date: date, future: false, inquiries: 10, closed: 0, done: 0, cohort_closed: 3, cohort_done: 3, cohort_orders_created: 3,
        cohort_finance: [{ currency: 'PHP', net_minor: net, received_minor: 100000, gross_minor: 100000, salary_minor: 40000, ad_spend_minor: 60000 - net }],
        finance: [{ currency: 'PHP', net_minor: -net, gross_minor: 0, salary_minor: 0, ad_spend_minor: 1000 }], salary_rates: [], created_orders: { count: 0 } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ month: '2026-11', selected_day: '2026-11-14', days: [day('2026-11-11', -1000), day('2026-11-12', 1000), { ...day('2026-11-13', 60000), cohort_finance: [{ currency: 'PHP', net_minor: 60000, received_minor: 100000, gross_minor: 100000, salary_minor: 40000, ad_spend_minor: 0, spend_usable: true }] }], selected: { future: true, cohort: {} }, pages: [] })));
    await act(async () => { view = create(createElement(Calendar, { scope: { role: 'owner' }, pages: [] })); });
    const loss = view.root.findByProps({ 'aria-label': 'Work date 2026-11-11' });
    const profit = view.root.findByProps({ 'aria-label': 'Work date 2026-11-12' });
    expect(loss.props.style.backgroundColor).toContain('hsl(0 ');
    expect(profit.props.style.backgroundColor).toContain('hsl(140 ');
    expect(text(loss)).toContain('CD 3'); expect(text(loss)).toContain('DD 3'); expect(text(loss)).toContain('Completed sales');
    expect(text(profit)).toContain('Ad result: profit');
    const noSpend=view.root.findByProps({'aria-label':'Work date 2026-11-13'});expect(noSpend.props.style.backgroundColor).toBe('#ffffff');expect(text(noSpend)).toContain('No ad spend - no shading');expect(text(noSpend)).toContain('Client earnings after commission (no ads)');expect(text(noSpend)).not.toContain('profit');
    expect(view.root.findAllByType('option').some(o => o.props.value === 'net')).toBe(false);
    const calls=(fetch as any).mock.calls.length;
    const daily=view.root.findAllByType('button').find(b=>text(b)==='Daily performance')!;
    await act(async()=>daily.props.onClick());
    expect((fetch as any).mock.calls.length).toBe(calls);
    const dailyTile=view.root.findByProps({'aria-label':'Work date 2026-11-12'});
    expect(text(dailyTile)).toContain('CD 0');expect(text(dailyTile)).toContain('DD 0');expect(text(dailyTile)).toContain('Daily net loss');
    expect(dailyTile.props.style.backgroundColor).toContain('hsl(0 ');
    const inquiries=view.root.findAllByType('button').find(b=>text(b)==='Inquiry-date results')!;
    await act(async()=>inquiries.props.onClick());
    expect(text(view.root.findByProps({'aria-label':'Work date 2026-11-12'}))).toContain('CD 3');

});

it('switches the complete daily report to actual money made and spent, with no inquiry sections or extra request',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-14T08:00:00Z'));
 const input={as_of:'2026-11-14T08:00:00Z',scope:{role:'owner',launch_at:'2026-11-01T00:00:00Z'},pages:[{id:'page',name:'Page'}],
 leads:[{id:'buyer',page_id:'page',name:'Buyer',stage:'converted',inquiry_at:'2026-11-01T01:00:00Z'}],selected_clients:[],
 orders:[{order_key:'order',contact_id:'buyer',seller_id:'seller',currency:'PHP',paid_minor:100000,total_minor:100000,commission_minor:35000,financial_source:'workspace',closed_at:'2026-11-13T01:00:00Z',closed_date:'2026-11-13',done_at:'2026-11-14T01:00:00Z',done_date:'2026-11-14'}],
 cash:[{contact_id:'buyer',currency:'PHP',amount_minor:30000,paid_day:'2026-11-13'},{contact_id:'buyer',currency:'PHP',amount_minor:70000,paid_day:'2026-11-14'}],
 spend:[{page_id:'page',currency:'PHP',spend_date:'2026-11-14',amount_minor:20000,complete:true}],peer_lag_hours:[],messages:[],message_coverage:[],page_plans:[],team_plans:[],employees:[],created_orders:[]};
 const report=buildVeoCalendar(input,{},'2026-11','2026-11-14');const fetcher=vi.fn(async()=>Response.json(report));vi.stubGlobal('fetch',fetcher);
 await act(async()=>{view=create(createElement(Calendar,{scope:{role:'owner'},pages:input.pages}));});
 expect(view.root.findAllByProps({'aria-label':'Daily money made and spent'})).toHaveLength(0);
 expect(text(view.toJSON())).toContain('Clients acquired on');const reads=fetcher.mock.calls.length;
 const daily=view.root.findAllByType('button').find(b=>text(b)==='Daily performance')!;
 await act(async()=>daily.props.onClick());
 const summary=view.root.findByProps({'aria-label':'Daily money made and spent'});
 for(const label of ['Sales made','Money received','Ad spend','Staff commission','Total costs','Daily net profit','1,000.00','700.00','200.00','350.00','550.00','450.00'])expect(text(summary)).toContain(label);
 expect(text(view.toJSON())).not.toContain('Clients acquired on');expect(text(view.toJSON())).not.toContain('Possible additional conversions within 30 days');
 expect(view.root.findByProps({'aria-label':'Monthly earnings and daily averages'})).toBeTruthy();expect(fetcher.mock.calls.length).toBe(reads);
 const shading=view.root.findAllByType('select').find(select=>select.props.value==='cohort_net')!;
 await act(async()=>shading.props.onChange({target:{value:'inquiries'}}));
 const dailyTile=view.root.findByProps({'aria-label':'Work date 2026-11-14'});
 expect(text(dailyTile)).toContain('Sales made');expect(text(dailyTile)).toContain('1,000.00');expect(text(dailyTile)).toContain('DD 1');

 const inquiry=view.root.findAllByType('button').find(b=>text(b)==='Inquiry-date results')!;await act(async()=>inquiry.props.onClick());
 expect(view.root.findAllByProps({'aria-label':'Daily money made and spent'})).toHaveLength(0);expect(text(view.toJSON())).toContain('Clients acquired on');
});

it('displays same-day conversion percentages, counts, later outcomes and empty-date explanations',async()=>{
 const outcome=(clients:number,rate:number|null)=>({clients,rate});
 const stats={inquiries:10,same_day_closed:outcome(4,.4),same_day_done:outcome(2,.2),same_day_both:outcome(2,.2),eventually_closed:outcome(6,.6),eventually_done:outcome(5,.5),closed_later:outcome(2,.2),done_later:outcome(3,.3),history_checked:10,provisional:true};
 await act(async()=>{view=create(createElement(InquiryConversionSummary,{day:{work_date:'2026-11-14',inquiry_conversion:stats}}));});
 const result=text(view.toJSON());for(const value of ['40.0%','20.0%','4 of 10 inquiry clients','2 first closed on a later date','3 first completed on a later date','Today is still in progress'])expect(result).toContain(value);
 const empty={...stats,inquiries:0,same_day_closed:outcome(0,null),same_day_done:outcome(0,null),same_day_both:outcome(0,null),eventually_closed:outcome(0,null),eventually_done:outcome(0,null)};
 await act(async()=>view.update(createElement(InquiryConversionSummary,{day:{work_date:'2026-11-14',inquiry_conversion:empty}})));
 expect(text(view.toJSON())).toContain('No inquiries');expect(text(view.toJSON())).not.toContain('NaN');
});
