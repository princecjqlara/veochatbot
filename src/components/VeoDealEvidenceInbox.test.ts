import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, it, expect, vi } from 'vitest';
import Inbox from './VeoDealEvidenceInbox';
let view:ReactTestRenderer;
const text=(v:any):string=>typeof v==='string'?v:(v?.children||[]).map(text).join('');
afterEach(async()=>{if(view)await act(async()=>view.unmount());vi.unstubAllGlobals();});
it('keeps client and Page selection and links the existing order with the right remaining amount',async()=>{
 const fetcher=vi.fn(async(url:string)=>new Response(JSON.stringify(url.includes('/api/workspace?contact_id=client')?{contact:{id:'client',page_id:'page',name:'Selected Client'},orders:[{id:'order',seller_id:'worker',total_minor:100000,paid_minor:0,currency:'PHP',description:'Earlier order'},{id:'other-order',seller_id:'other',total_minor:900000,currency:'PHP'}],closed_deals:[{id:'cd',seller_id:'worker',order_id:'order',amount_minor:30000}]}:{items:[],total:0,pages:[{id:'page',name:'Page A'}]})));vi.stubGlobal('fetch',fetcher);
 await act(async()=>{view=create(createElement(Inbox,{scope:{user_id:'worker',role:'member'},accounts:[{id:'worker',role:'member',name:'Worker'}],initialContactId:'client',initialKind:'done'}));});
 const label=(prefix:string)=>view.root.findAllByType('label').find(l=>text(l).startsWith(prefix))!;
 expect(label('Client').findByType('select').props.value).toBe('client');expect(text(view.toJSON())).toContain('Selected Client');expect(label('Filter Page')).toBeTruthy();
 expect(label('Link this client').findAllByType('option').some(o=>o.props.value==='other-order')).toBe(false);
 await act(async()=>label('Link this client').findByType('select').props.onChange({target:{value:'order'}}));
 expect(label('Total deal price').findByType('input').props.value).toBe('1000.00');expect(label('Done Deal amount').findByType('input').props.value).toBe('700.00');expect(text(view.toJSON())).toContain('Earlier Close Deal');expect(label('Tip received now')).toBeTruthy();
 expect(view.root.findAllByProps({type:'file'})).toHaveLength(3);expect(fetcher.mock.calls.every(([,o]:any)=>!o?.method)).toBe(true);
});
it('requires checking every photo before an independent supervisor can approve',async()=>{
 const review={id:'review',client_name:'Client',page_name:'Page',seller_name:'Worker',receipt_kind:'closed',status:'pending',can_review:true,total_price_minor:100000,closed_amount_minor:30000,currency:'PHP',photos:['stage','payment','order'].map(slot=>({slot,available:true,photo_url:'https://example.test/'+slot}))};
 const fetcher=vi.fn(async(url:string,options?:any)=>new Response(JSON.stringify(options?.method==='POST'?{review:{...review,status:'approved'}}:url.includes('review_id=')?{review}:{items:[review],total:1,pages:[]})));vi.stubGlobal('fetch',fetcher);
 await act(async()=>{view=create(createElement(Inbox,{scope:{user_id:'owner',role:'owner'},accounts:[]}));});
 await act(async()=>view.root.findAllByType('button').find(b=>text(b)==='View evidence')!.props.onClick());
 const approve=()=>view.root.findAllByType('button').find(b=>text(b)==='Approve & record deal')!;expect(approve().props.disabled).toBe(true);expect(view.root.findAllByType('img')).toHaveLength(3);
 for(const input of view.root.findAllByProps({type:'checkbox'}))await act(async()=>input.props.onChange({target:{checked:true}}));
 expect(approve().props.disabled).toBe(false);await act(async()=>approve().props.onClick());
 const post=fetcher.mock.calls.find(([,o])=>o?.method==='POST')!;expect(JSON.parse(post[1].body)).toMatchObject({action:'review',review_id:'review',decision:'approve',confirm_stage:true,confirm_receipt:true,confirm_order:true});
});
