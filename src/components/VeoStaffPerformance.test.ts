import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('next/link',()=>({default:({href,children}:any)=>createElement('a',{href},children)}));
import Performance from './VeoStaffPerformance';
import { buildStaffPerformance } from '@/lib/veo-staff-performance';
let view:ReactTestRenderer;
const text=(node:any):string=>typeof node==='string'||typeof node==='number'?String(node):(node?.children||[]).map(text).join('');
const fixture=()=>buildStaffPerformance({as_of:'2026-11-11T02:00:00Z',days:[
    {work_date:'2026-11-09',closed:2,done:1,replies:{incoming_clients:2,answered_clients:1},totals:[{currency:'PHP',order_gross_minor:10000,gross_minor:10000,commission_minor:3500},{currency:'USD',order_gross_minor:100,gross_minor:100,commission_minor:35}]},
    {work_date:'2026-11-10',closed:0,done:0,replies:{incoming_clients:0,answered_clients:0},totals:[]},
    {work_date:'2026-11-11',closed:99,done:99,totals:[]}
],performance_inputs:{version:1,current_clients:5,ever_assigned_clients:8,new_clients:[{work_date:'2026-11-09',new_clients:2}],overall_ranking:{rank:2,peers:5},page_rankings:[{page_id:'page',page_name:'Page A',rank:1,peers:3,done:1,closed:2}],cd_turnaround:{count:1,mean_hours:2,median_hours:2,fastest:{hours:2,contact_id:'client',page_id:'page',contact_name:'Client',page_name:'Page A'},slowest:{hours:2}},video_turnaround:{count:0},cost_model:'Missing costs remain unknown.',ad_costs:[]}})!;
afterEach(async()=>{if(view)await act(async()=>view.unmount());});
it('shows distinct business profit and personal earnings with dates, ranks, turnaround and accessible graphs',async()=>{
    await act(async()=>{view=create(createElement(Performance,{data:fixture(),rankingScope:'Your team'}));});
    const output=text(view.toJSON());expect(output).toContain('Average daily gross profit');expect(output).toContain('Average daily staff earnings');expect(output).toContain('Average daily estimated net profit');
    expect(output).toContain('No matching recorded timestamps');expect(output).toContain('#2');expect(output).toContain('#1 of 3');expect(output).toContain('2 completed employment dates');
    expect(view.root.findAllByProps({role:'img'})).toHaveLength(4);expect(view.root.findByProps({href:'/dashboard/contacts/client?pageId=page'})).toBeTruthy();
    expect(output).toContain('2026-11-11 · Provisional');
});
it('keeps unknown net profit out of the graph and lets currency and weekday metric change independently',async()=>{
    await act(async()=>{view=create(createElement(Performance,{data:fixture(),rankingScope:'Your team'}));});
    expect(view.root.findAllByType('title').some(node=>text(node).includes(': Estimated net profit'))).toBe(false);
    await act(async()=>{view.root.findByProps({'aria-label':'Performance currency'}).props.onChange({target:{value:'USD'}});view.root.findByProps({'aria-label':'Weekday performance metric'}).props.onChange({target:{value:'new_clients'}});});
    expect(view.root.findByProps({'aria-label':'Daily staff sales earnings and profit in USD'})).toBeTruthy();
    expect(text(view.toJSON())).toContain('New clients per observed weekday');expect(text(view.toJSON())).toContain('Unavailable');
});
