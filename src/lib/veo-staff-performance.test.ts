import { expect, it } from 'vitest';
import { buildStaffPerformance } from './veo-staff-performance';
const row=(work_date:string,done:number,totals:any[]=[])=>({work_date,done,closed:done,totals,replies:{incoming_clients:2,answered_clients:1}});
const input=()=>({as_of:'2026-11-10T16:00:00Z',days:[row('2026-11-03',2,[{currency:'PHP',order_gross_minor:10000,gross_minor:8000,commission_minor:3200}]),row('2026-11-04',0),row('2026-11-10',2),row('2026-11-11',99)],
    performance_inputs:{version:1,current_clients:2,ever_assigned_clients:5,clients_with_sales:3,new_clients:[{work_date:'2026-11-03',new_clients:3}],ad_costs:[{work_date:'2026-11-03',currency:'PHP',ad_cost_minor:100,pages_expected:1,pages_known:1},{work_date:'2026-11-04',currency:'PHP',ad_cost_minor:0},{work_date:'2026-11-10',currency:'PHP',ad_cost_minor:200}]}});
it('includes zero-sales dates and excludes provisional today from daily averages and weekday comparisons',()=>{
    const p=buildStaffPerformance(input())!;
    expect(p.completed_days).toBe(3);expect(p.average_done).toBeCloseTo(4/3);expect(p.average_new_clients).toBe(1);expect(p.new_clients).toBe(3);
    expect(p.sales_days).toBe(2);expect(p.zero_sales_days).toBe(1);expect(p.best_weekday).toMatchObject({name:'Tuesday',days:2,average_done:2});
    expect(p.best_dates.every((day:any)=>day.work_date!=='2026-11-11')).toBe(true);expect(p.weekdays.find(day=>day.name==='Sunday')?.average_done).toBeNull();
});
it('separates gross sales, verified net revenue, employee earnings and business profit after refunds',()=>{
    const p=buildStaffPerformance(input())!;const total=p.completed_totals[0];
    expect(total).toMatchObject({gross_minor:10000,revenue_minor:8000,salary_minor:3200,gross_profit_minor:4800,ad_cost_minor:300,net_profit_minor:4500,average_salary_minor:3200/3,average_gross_profit_minor:1600,average_net_profit_minor:1500});
    expect(p.days.find((day:any)=>day.work_date==='2026-11-10').finance[0].net_profit_minor).toBe(-200);
});
it('does not turn missing costs into zero or average only the profitable known days',()=>{
    const sample=input();sample.performance_inputs.ad_costs.pop();
    const p=buildStaffPerformance(sample)!;expect(p.completed_totals[0]).toMatchObject({net_profit_minor:null,average_net_profit_minor:null,cost_known_days:2,cost_missing_days:1});
    expect(p.days.find((day:any)=>day.work_date==='2026-11-10').finance[0].net_profit_minor).toBeNull();
});
it('keeps currencies separate and has no daily averages before a completed employment date',()=>{
    const sample=input();sample.days=[row('2026-11-11',2,[{currency:'USD',order_gross_minor:100,gross_minor:100,commission_minor:35},{currency:'PHP',order_gross_minor:10000,gross_minor:10000,commission_minor:3500}])];
    const p=buildStaffPerformance(sample)!;expect(p.currencies).toEqual(['PHP','USD']);expect(p.completed_days).toBe(0);expect(p.best_weekday).toBeNull();expect(p.completed_totals.every(row=>row.average_gross_minor===null&&row.average_net_profit_minor===null)).toBe(true);
});
