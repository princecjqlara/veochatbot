import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, it, expect, vi } from 'vitest';
import Inbox from './VeoDealEvidenceInbox';
let view:ReactTestRenderer;
const text=(v:any):string=>typeof v==='string'?v:(v?.children||[]).map(text).join('');
afterEach(async()=>{if(view)await act(async()=>view.unmount());vi.unstubAllGlobals();});
it.each(['manager','team_leader','owner','member'])('shows the correct submission action for %s while retaining the contact selector',async role=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({items:[],total:0})));vi.stubGlobal('fetch',fetcher);
 await act(async()=>{view=create(createElement(Inbox,{scope:{user_id:'actor',role,supervisor_submissions_enabled:true},accounts:[]}));});
 expect(text(view.toJSON())).toContain(role==='member'?'Submit for review':'Submit & send');
 expect(view.root.findAllByType('label').find(l=>text(l).startsWith('Client'))!.findByType('select')).toBeTruthy();
});
it('labels manager receipts as submitted without inventing a separate reviewer',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({items:[{id:'direct',status:'approved',approval_mode:'supervisor_submission',client_name:'Client',page_name:'Page',seller_name:'Staff',reviewer_name:'Manager',occurred_at:'2026-11-12',receipt_kind:'closed',currency:'PHP',delivery_status:'queued'}],total:1}))));
 await act(async()=>{view=create(createElement(Inbox,{scope:{user_id:'manager',role:'manager',supervisor_submissions_enabled:true},accounts:[],compact:true}));});
 expect(text(view.toJSON())).toContain('recorded — no review required');expect(text(view.toJSON())).toContain('Submitted by Manager');expect(text(view.toJSON())).not.toContain('Reviewed by Manager');
});
it('keeps Salary compact with the approval list and a link to the full receipt form',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({items:[],total:0})));vi.stubGlobal('fetch',fetcher);
 await act(async()=>{view=create(createElement(Inbox,{scope:{user_id:'worker',role:'member'},accounts:[],compact:true}));});
 expect(view.root.findAllByType('form')).toHaveLength(0);expect(view.root.findByProps({href:'/dashboard/workspace?view=receipts'})).toBeTruthy();expect(text(view.toJSON())).toContain('Review inbox');
 expect(fetcher.mock.calls).toHaveLength(1);
});
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
it('clears the earlier order amounts when switching to a direct Done Deal and submits without a tip',async()=>{
 const saves:any[]=[];let uploads=0;
 vi.stubGlobal('FormData',class{data=new Map();constructor(_form?:any){}set(k:string,v:any){this.data.set(k,v);}get(k:string){return this.data.get(k)||(k==='description'?'Video deal':'');}});
 vi.stubGlobal('fetch',vi.fn(async(url:string,options?:any)=>{
  if(url.endsWith('/upload'))return new Response(JSON.stringify({photo:{id:'photo-'+(++uploads)}}));
  if(options?.method==='POST'){saves.push(JSON.parse(options.body));return new Response(JSON.stringify({review:{status:'approved',approval_mode:'supervisor_submission'},delivery_dispatch:{state:'queued'}}));}
  return new Response(JSON.stringify(url.includes('/api/workspace?contact_id=client')?{contact:{id:'client',page_id:'page',name:'Client'},orders:[{id:'old-order',seller_id:'manager',total_minor:100000,paid_minor:0,currency:'PHP'}],closed_deals:[{id:'old-cd',seller_id:'manager',order_id:'old-order',amount_minor:30000}]}:{items:[],total:0}));
 }));
 await act(async()=>{view=create(createElement(Inbox,{scope:{user_id:'manager',role:'manager',supervisor_submissions_enabled:true},accounts:[{id:'manager',role:'manager'}],initialContactId:'client',initialKind:'done'}));});
 const label=(prefix:string)=>view.root.findAllByType('label').find(l=>text(l).startsWith(prefix))!;
 const input=(prefix:string)=>label(prefix).findByType('input');
 await act(async()=>label('Link this client').findByType('select').props.onChange({target:{value:'old-order'}}));
 expect(input('Done Deal amount').props.value).toBe('700.00');
 await act(async()=>label('Link this client').findByType('select').props.onChange({target:{value:''}}));
 expect(input('Total deal price').props.value).toBe('');expect(input('Done Deal amount').props.value).toBe('');
 await act(async()=>input('Total deal price').props.onChange({target:{value:'2000'}}));
 expect(input('Done Deal amount').props.value).toBe('2000');
 await act(async()=>input('Total deal price').props.onChange({target:{value:'2500'}}));
 expect(input('Done Deal amount').props.value).toBe('2500');
 expect(input('Tip received now').props.required).toBeUndefined();
 await act(async()=>input('Tip received now').props.onChange({target:{value:''}}));
 for(const file of view.root.findAllByProps({type:'file'}))await act(async()=>file.props.onChange({target:{files:[{size:1}]}}));
 await act(async()=>view.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{reset(){}}}));
 expect(saves).toHaveLength(1);expect(saves[0]).toMatchObject({receipt_kind:'done',total_price:'2500',done_amount:'2500',tip:'',order_id:null,closed_deal_id:null,photo_ids:['photo-1','photo-2','photo-3']});expect(uploads).toBe(3);expect(text(view.toJSON())).toContain('Receipt recorded');
});
it('checks the direct Done Deal amount before uploading photos and allows correcting it',async()=>{
 let writes=0;
 vi.stubGlobal('fetch',vi.fn(async(url:string,options?:any)=>{if(options?.method==='POST')writes++;return new Response(JSON.stringify(url.includes('/api/workspace?contact_id=client')?{contact:{id:'client',page_id:'page'},orders:[],closed_deals:[]}:{items:[],total:0}));}));
 await act(async()=>{view=create(createElement(Inbox,{scope:{user_id:'manager',role:'manager',supervisor_submissions_enabled:true},accounts:[{id:'manager',role:'manager'}],initialContactId:'client',initialKind:'done'}));});
 const input=(prefix:string)=>view.root.findAllByType('label').find(l=>text(l).startsWith(prefix))!.findByType('input');
 await act(async()=>input('Total deal price').props.onChange({target:{value:'1000'}}));
 await act(async()=>input('Done Deal amount').props.onChange({target:{value:'700'}}));
 await act(async()=>input('Total deal price').props.onChange({target:{value:'1200'}}));
 expect(input('Done Deal amount').props.value).toBe('700');
 await act(async()=>view.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{reset(){}}}));
 expect(writes).toBe(0);expect(text(view.toJSON())).toContain('PHP 1200.00');
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
it('allows correcting a confirmed validation failure while reusing its already uploaded photos',async()=>{
 const saves:any[]=[];let uploads=0;
 vi.stubGlobal('FormData',class{data=new Map();constructor(_form?:any){}set(k:string,v:any){this.data.set(k,v);}get(k:string){return this.data.get(k)||(k==='description'?'Video deal':'');}});
 const fetcher=vi.fn(async(url:string,options?:any)=>{
  if(url.endsWith('/upload')){uploads++;return new Response(JSON.stringify({photo:{id:'photo-'+uploads}}));}
  if(options?.method==='POST'){saves.push(JSON.parse(options.body));return saves.length===1?new Response(JSON.stringify({error:'Check the payment date'}),{status:422}):new Response(JSON.stringify({review:{duplicate:false}}));}
  return new Response(JSON.stringify(url.includes('/api/workspace?contact_id=client')?{contact:{id:'client',page_id:'page',name:'Client'},orders:[],closed_deals:[]}:{items:[],total:0}));
 });vi.stubGlobal('fetch',fetcher);
 await act(async()=>{view=create(createElement(Inbox,{scope:{user_id:'worker',role:'member'},accounts:[{id:'worker',role:'member'}],initialContactId:'client'}));});
 const label=(prefix:string)=>view.root.findAllByType('label').find(l=>text(l).startsWith(prefix))!;
 await act(async()=>{label('Total deal price').findByType('input').props.onChange({target:{value:'1000'}});label('Close Deal amount').findByType('input').props.onChange({target:{value:'300'}});});
 for(const input of view.root.findAllByProps({type:'file'}))await act(async()=>input.props.onChange({target:{files:[{size:1}]}}));
 const submit=()=>view.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{reset(){}}});
 await act(async()=>{await submit();});expect(text(view.toJSON())).toContain('Check the payment date');
 await act(async()=>label('Total deal price').findByType('input').props.onChange({target:{value:'1200'}}));
 await act(async()=>{await submit();});expect(saves.map(s=>s.total_price)).toEqual(['1000','1200']);expect(uploads).toBe(3);expect(text(view.toJSON())).toContain('Submitted for supervisor review');
});
