import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m=vi.hoisted(()=>({scope:vi.fn(),rpc:vi.fn(),from:vi.fn(),filters:[] as any[],failure:'',orders:[] as any[]}));
vi.mock('@/lib/supabase',()=>({getSupabaseAdmin:()=>m}));
vi.mock('@/lib/veo-deal-review',()=>({dealReviewScope:m.scope}));
import { GET } from './route';
const contact='00000000-0000-4000-8000-000000000001',seller='00000000-0000-4000-8000-000000000002';
const read=(query=`contact_id=${contact}&seller_id=${seller}`)=>GET(new NextRequest('https://veo.test/api/workspace/deal-reviews/client?'+query));
beforeEach(()=>{
 vi.clearAllMocks();m.filters=[];m.failure='';m.orders=[];
 m.scope.mockResolvedValue({user_id:'actor'});m.rpc.mockResolvedValue({data:{page_id:'page',contact_id:contact,seller_id:seller}});
 m.from.mockImplementation(table=>{
  const result=()=>table===m.failure?{error:{code:'57014',message:'Query timed out'}}:{data:table==='contacts'?{id:contact,name:'Client'}:table==='veo_order_facts'?m.orders:[]};
  const q:any={select:()=>q,eq:(...args:any[])=>{m.filters.push([table,...args]);return q;},in:(...args:any[])=>{m.filters.push([table,...args]);return q;},is:()=>q,order:()=>q,maybeSingle:()=>q,then:(resolve:any,reject:any)=>Promise.resolve(result()).then(resolve,reject)};
  return q;
 });
});
it('loads receipt inputs without legacy finances, demographic details or other sellers',async()=>{
 const r=await read();expect(r.status).toBe(200);expect(await r.json()).toMatchObject({contact:{id:contact},orders:[],closed_deals:[],payments:[]});
 expect(m.rpc).toHaveBeenCalledWith('veo_deal_review_context',{p_actor:'actor',p_contact:contact,p_seller:seller});
 expect(m.from.mock.calls.map(([table])=>table)).toEqual(['contacts','veo_order_facts','veo_closed_deals']);
 for(const table of ['veo_order_facts','veo_closed_deals'])expect(m.filters).toContainEqual([table,'seller_id',seller]);
 expect(r.headers.get('Cache-Control')).toBe('no-store');
});
it('reads payments only for the current seller orders',async()=>{
 m.orders=[{id:'order',seller_id:seller}];expect((await read()).status).toBe(200);
 expect(m.filters).toContainEqual(['veo_payments','order_id',['order']]);
});
it.each(['contacts','veo_order_facts','veo_closed_deals','veo_payments'])('keeps %s failures retryable instead of assuming no orders',async table=>{
 m.orders=[{id:'order'}];m.failure=table;const r=await read();expect(r.status).toBe(503);expect(r.headers.get('Retry-After')).toBe('5');
 expect((await r.json()).error).toContain('have not been removed');
});
it('rejects unauthorized clients or sellers before reading their records',async()=>{
 m.rpc.mockResolvedValue({error:{code:'42501',message:'Choose a permitted contact and selling staff account'}});
 expect((await read()).status).toBe(403);expect(m.from).not.toHaveBeenCalled();
});
it('shows the saved seller-assignment explanation without retrying unrelated client reads',async()=>{
 const message='This client is assigned to Shielo. Select the assigned seller or ask your Manager or Team Leader to reassign the client before submitting a new sale.';
 m.rpc.mockResolvedValue({error:{code:'42501',message}});
 const r=await read();expect(r.status).toBe(403);expect(await r.json()).toEqual({error:message});
 expect(m.from).not.toHaveBeenCalled();expect(m.rpc).toHaveBeenCalledTimes(1);
});
it('requires current sign-in and suspension checks before reading records',async()=>{
 m.scope.mockRejectedValue(Object.assign(Error('Account suspended'),{status:403}));
 expect((await read()).status).toBe(403);expect(m.rpc).not.toHaveBeenCalled();expect(m.from).not.toHaveBeenCalled();
});
it('fails closed when the permission context is incomplete',async()=>{
 m.rpc.mockResolvedValue({data:null});expect((await read()).status).toBe(503);expect(m.from).not.toHaveBeenCalled();
});
it('validates both identifiers before querying',async()=>{
 expect((await read('contact_id=invalid&seller_id='+seller)).status).toBe(400);expect(m.rpc).not.toHaveBeenCalled();
});
