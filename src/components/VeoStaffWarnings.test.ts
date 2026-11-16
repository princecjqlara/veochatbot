import {createElement} from 'react';
import {act,create,type ReactTestRenderer} from 'react-test-renderer';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
vi.mock('next/link',()=>({default:({children,...props}:any)=>createElement('a',props,children)}));
import Warnings from './VeoStaffWarnings';
let view:ReactTestRenderer;
const text=(v:any):string=>typeof v==='string'||typeof v==='number'?String(v):(v?.children||[]).map(text).join('');
const data={as_of:'2026-11-16T01:00:00Z',tomorrow:'2026-11-17',workers:[
    {id:'alice',name:'Alice',role:'member',active:true,warnings:[{key:'late',kind:'overdue_without_reason',severity:'warning',title:'Project overdue',overdue_hours:3.2,due_at:'2026-11-15T12:00:00Z'}]},
    {id:'bob',name:'Bob',role:'member',active:true,warnings:[{key:'receipt',kind:'salary_on_hold',severity:'hold',title:'Salary receipt on hold',reasons:['facebook_stage_unavailable']}]},
    {id:'clear',name:'Clear employee',role:'member',active:true,warnings:[]}
]};
beforeEach(()=>{vi.stubGlobal('fetch',vi.fn(async()=>Response.json(data)));});
afterEach(async()=>{if(view)await act(async()=>view.unmount());vi.unstubAllGlobals();});
async function mount(props:any={}){await act(async()=>{view=create(createElement(Warnings,props));});}
it('uses compact issue rows and filters counts by employee, severity and type',async()=>{
    await mount();expect(view.root.findAllByType('article')).toHaveLength(0);expect(view.root.findByType('tbody').findAllByType('tr')).toHaveLength(2);
    await act(async()=>view.root.findByProps({'aria-label':'Warning employee'}).props.onChange({target:{value:'bob'}}));
    expect(view.root.findByType('tbody').findAllByType('tr')).toHaveLength(1);expect(text(view.toJSON())).toContain('0 warnings · 1 salary holds');
    await act(async()=>view.root.findByProps({'aria-label':'Warning severity'}).props.onChange({target:{value:'warning'}}));
    expect(text(view.toJSON())).toContain('No warnings match these filters');
    await act(async()=>{view.root.findByProps({'aria-label':'Warning employee'}).props.onChange({target:{value:''}});view.root.findByProps({'aria-label':'Warning severity'}).props.onChange({target:{value:''}});view.root.findByProps({'aria-label':'Warning type'}).props.onChange({target:{value:'overdue_without_reason'}});});
    expect(view.root.findByType('tbody').findAllByType('tr')).toHaveLength(1);expect(text(view.root.findByType('tbody'))).toContain('4 hours overdue');
});
it('limits compact panels and leaves full warnings accessible',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({...data,workers:[{...data.workers[0],warnings:Array.from({length:12},(_,i)=>({...data.workers[0].warnings[0],key:String(i)}))}]})));
    await mount({compact:true});expect(view.root.findByType('tbody').findAllByType('tr')).toHaveLength(6);expect(view.root.findByProps({href:'/dashboard/workspace?view=warnings'})).toBeDefined();
});
it('reports a failed source without displaying a false zero-warning result',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({error:'Warnings unavailable'},{status:503})));
    await mount();expect(view.root.findByProps({role:'alert'}).children).toContain('Warnings unavailable');expect(text(view.toJSON())).not.toContain('0 warnings');
});
it('ignores a late response for the previously selected worker',async()=>{
    let finish!:(response:Response)=>void;
    vi.stubGlobal('fetch',vi.fn().mockImplementationOnce(()=>new Promise<Response>(resolve=>{finish=resolve;})).mockResolvedValue(Response.json({...data,workers:[data.workers[1]]})));
    await mount({workerId:'alice'});await act(async()=>view.update(createElement(Warnings,{workerId:'bob'})));
    await act(async()=>finish(Response.json({...data,workers:[data.workers[0]]})));
    expect(text(view.root.findByType('tbody'))).toContain('Bob');expect(text(view.root.findByType('tbody'))).not.toContain('Alice');
});
