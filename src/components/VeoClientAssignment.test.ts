import {afterEach,expect,it,vi} from 'vitest';
import {createElement} from 'react';
import {act,create,ReactTestRenderer} from 'react-test-renderer';
import Assignment from './VeoClientAssignment';
let view:ReactTestRenderer;
const current={contact:{id:'contact',name:'Do Nna',page_name:'Azshinari'},owner:{id:'shielo',name:'Shielo'},targets:[{id:'troy',name:'Troy',role:'member'}]};
const text=(value:any):string=>typeof value==='string'?value:JSON.stringify(value);
afterEach(()=>{if(view)act(()=>view.unmount());vi.unstubAllGlobals();});
async function choose(){await act(async()=>view.root.findByType('select').props.onChange({target:{value:'troy'}}));await act(async()=>view.root.findByType('textarea').props.onChange({target:{value:'Correct receipt assignment'}}));}
it('shows the current owner and submits the chosen worker, expected owner and required reason once',async()=>{
 const saved=vi.fn(),fetcher=vi.fn(async(_url:string,options?:RequestInit)=>Response.json(options?.method==='POST'?{...current,saved:true,owner:{id:'troy',name:'Troy'}}:current));vi.stubGlobal('fetch',fetcher);
 await act(async()=>{view=create(createElement(Assignment,{initialContactId:'contact',onSaved:saved}));});
 expect(text(view.toJSON())).toContain('Shielo');expect(view.root.findByProps({type:'submit'}).props.disabled).toBe(true);
 await choose();await act(async()=>view.root.findByType('form').props.onSubmit({preventDefault(){}}));
 const writes=fetcher.mock.calls.filter(([,o])=>o?.method==='POST');expect(writes).toHaveLength(1);
 expect(JSON.parse(String(writes[0][1]?.body))).toEqual({contact_id:'contact',seller_id:'troy',expected_owner_id:'shielo',reason:'Correct receipt assignment'});
 expect(saved).toHaveBeenCalledOnce();expect(text(view.toJSON())).toContain('Past receipts, payments and sales credit are preserved');
});
it.each([409,503])('requires reloading after HTTP %s and does not automatically retry a write',async status=>{
 const fetcher=vi.fn(async(_url:string,options?:RequestInit)=>options?.method==='POST'?Response.json({error:'Reload the changed assignment'},{status}):Response.json(current));vi.stubGlobal('fetch',fetcher);
 await act(async()=>{view=create(createElement(Assignment,{initialContactId:'contact'}));});await choose();await act(async()=>view.root.findByType('form').props.onSubmit({preventDefault(){}}));
 expect(view.root.findByProps({type:'submit'}).props.disabled).toBe(true);expect(text(view.toJSON())).toContain('Reload the changed assignment');
 await act(async()=>view.root.findByType('form').props.onSubmit({preventDefault(){}}));
 expect(fetcher.mock.calls.filter(([,o])=>o?.method==='POST')).toHaveLength(1);
 await act(async()=>view.root.findAllByType('button').find(b=>b.children.join('')==='Reload current assignment')!.props.onClick());
 expect(view.root.findByType('textarea').props.value).toBe('');expect(view.root.findByType('select').props.value).toBe('');
});
