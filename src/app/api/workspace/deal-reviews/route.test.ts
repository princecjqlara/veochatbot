import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m=vi.hoisted(()=>({scope:vi.fn(),rpc:vi.fn(),queue:vi.fn()}));
vi.mock('@/lib/supabase',()=>({getSupabaseAdmin:()=>({rpc:m.rpc})}));
vi.mock('@/lib/veo-deal-review',async original=>({...await original<any>(),dealReviewScope:m.scope}));
vi.mock('@/lib/veo-reviewed-delivery',()=>({queueReviewedDelivery:m.queue}));
import { POST } from './route';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const request=(body:any)=>new NextRequest('https://veo.test/api/workspace/deal-reviews',{method:'POST',headers:{Origin:'https://veo.test','Content-Type':'application/json'},body:JSON.stringify(body)});
const submission=()=>({action:'submit',request_id:id(1),contact_id:id(2),seller_id:id(3),receipt_kind:'closed',photo_ids:[id(4),id(5),id(6)],total_price:'1000',closed_amount:'300',currency:'PHP',occurred_at:'2026-11-12T00:00:00+08:00'});
beforeEach(()=>{m.scope.mockResolvedValue({user_id:id(3),role:'manager',launch_at:'2026-11-09'});});
afterEach(()=>{vi.resetAllMocks();});
it('saves a manager receipt without an invoice reference and immediately queues its authorized result',async()=>{
 const review={id:id(7),status:'approved',approval_mode:'supervisor_submission',delivery_submission:id(8)};m.rpc.mockResolvedValue({data:review});m.queue.mockResolvedValue({state:'queued'});
 const response=await POST(request(submission()));expect(response.status).toBe(202);expect(await response.json()).toEqual({review,delivery_dispatch:{state:'queued'}});
 expect(m.rpc).toHaveBeenCalledWith('veo_submit_deal_review',expect.objectContaining({p_actor:id(3),p_data:expect.objectContaining({closed_amount_minor:30000,total_price_minor:100000,invoice_reference:''})}));
 expect(m.queue).toHaveBeenCalledOnce();expect(m.queue.mock.calls[0][1]).toBe(review);
});
it('submits a fully paid direct Done Deal without a Close Deal, existing order or optional tip',async()=>{
 m.rpc.mockResolvedValue({data:{id:id(7),status:'approved',approval_mode:'supervisor_submission',order_id:id(8)}});m.queue.mockResolvedValue({state:'queued'});
 const body={...submission(),receipt_kind:'done',closed_amount:'',done_amount:'1000',tip:'',order_id:null,closed_deal_id:null};
 const response=await POST(request(body));expect(response.status).toBe(202);
 expect(m.rpc.mock.calls[0][1].p_data).toMatchObject({order_id:null,closed_deal_id:null,total_price_minor:100000,closed_amount_minor:0,received_now_minor:100000,tip_minor:0});expect(m.queue).toHaveBeenCalledOnce();
});
it('explains an incomplete direct payment without writing a review or queuing Telegram',async()=>{
 const response=await POST(request({...submission(),receipt_kind:'done',done_amount:'700',tip:'0'}));expect(response.status).toBe(422);expect((await response.json()).error).toContain('PHP 1000.00');expect(m.rpc).not.toHaveBeenCalled();expect(m.queue).not.toHaveBeenCalled();
});
it('preserves the staff pending decision and ignores client-supplied role overrides',async()=>{
 m.scope.mockResolvedValue({user_id:id(3),role:'member',launch_at:'2026-11-09'});m.rpc.mockResolvedValue({data:{status:'pending'}});m.queue.mockResolvedValue({state:'awaiting_review'});
 const response=await POST(request({...submission(),approval_mode:'supervisor_submission',submitted_by_role:'manager'}));expect(response.status).toBe(202);expect((await response.json()).review.status).toBe('pending');
 expect(m.rpc.mock.calls[0][1].p_data).not.toHaveProperty('approval_mode');expect(m.rpc.mock.calls[0][1].p_data).not.toHaveProperty('submitted_by_role');
});
it('returns a saved receipt with an automatic retry status when immediate forwarding is unavailable',async()=>{
 m.rpc.mockResolvedValue({data:{id:id(7),status:'approved'}});m.queue.mockResolvedValue({state:'retry_scheduled'});
 const response=await POST(request(submission()));expect(response.status).toBe(202);expect((await response.json()).delivery_dispatch.state).toBe('retry_scheduled');expect(m.rpc).toHaveBeenCalledOnce();
});
it('does not queue a rejected database save or an incomplete photo selection',async()=>{
 m.rpc.mockResolvedValue({error:{code:'23514',message:'Photo slots incomplete'}});
 expect((await POST(request(submission()))).status).toBe(422);expect(m.queue).not.toHaveBeenCalled();m.rpc.mockClear();
 expect((await POST(request({...submission(),photo_ids:[id(4),id(4),id(6)]}))).status).toBe(400);expect(m.rpc).not.toHaveBeenCalled();
});
it('queues a staff receipt after supervisor approval while retaining staff review authorization',async()=>{
 m.rpc.mockResolvedValue({data:{id:id(7),status:'approved'}});m.queue.mockResolvedValue({state:'queued'});
 const body={action:'review',review_id:id(7),decision:'approve',note:'Checked',confirm_stage:true,confirm_receipt:true,confirm_order:true};
 expect((await POST(request(body))).status).toBe(200);expect(m.queue).toHaveBeenCalledOnce();
 m.queue.mockClear();m.rpc.mockClear();m.scope.mockResolvedValue({user_id:id(3),role:'member',launch_at:'2026-11-09'});
 expect((await POST(request(body))).status).toBe(403);expect(m.rpc).not.toHaveBeenCalled();expect(m.queue).not.toHaveBeenCalled();
});
it.each(['member','owner'])('denies reviewed receipt deletion to %s before accessing the database',async role=>{
 m.scope.mockResolvedValue({user_id:id(3),role,launch_at:'2026-11-09'});
 expect((await POST(request({action:'delete',review_id:id(7),reason:'Wrong photo'}))).status).toBe(403);expect(m.rpc).not.toHaveBeenCalled();
});
it.each(['manager','team_leader'])('allows scoped %s deletion with a reason',async role=>{
 m.scope.mockResolvedValue({user_id:id(3),role,launch_at:'2026-11-09'});m.rpc.mockResolvedValue({data:{id:id(7),deleted_at:'2026-11-13'}});
 expect((await POST(request({action:'delete',review_id:id(7),reason:'Wrong photo'}))).status).toBe(200);
 expect(m.rpc).toHaveBeenCalledWith('veo_deal_review_delete',{p_actor:id(3),p_id:id(7),p_reason:'Wrong photo'});
});
it('corrects a Close Deal price using integer money and the previous-price conflict guard',async()=>{
 m.rpc.mockResolvedValue({data:{total_price_minor:120000}});
 expect((await POST(request({action:'edit_price',review_id:id(7),total_price:'1200.00',expected_total_minor:100000,reason:'Correct package'}))).status).toBe(200);
 expect(m.rpc).toHaveBeenCalledWith('veo_close_deal_price',{p_actor:id(3),p_review:id(7),p_total:120000,p_expected:100000,p_reason:'Correct package'});
 m.rpc.mockClear();m.scope.mockResolvedValue({user_id:id(3),role:'member',launch_at:'2026-11-09'});
 expect((await POST(request({action:'edit_price',review_id:id(7),total_price:'1200',expected_total_minor:100000,reason:'Wrong price'}))).status).toBe(403);expect(m.rpc).not.toHaveBeenCalled();
});
it('saves the supervisor policy and scopes pending approval to that supervisor',async()=>{
 m.rpc.mockImplementation(async name=>({data:name==='veo_team_auto_approval_setting'?{enabled:true}:{approved:2}}));
 const r=await POST(request({action:'auto_approval',enabled:true}));expect(r.status).toBe(200);expect((await r.json()).pending.approved).toBe(2);
 expect(m.rpc).toHaveBeenCalledWith('veo_team_auto_approval_setting',{p_actor:id(3),p_enabled:true});
 expect(m.rpc).toHaveBeenCalledWith('veo_auto_approve_pending_team_reviews',{p_limit:20,p_supervisor:id(3)});
});
it('does not grant staff access to team auto-approval or accept a nonboolean setting',async()=>{
 expect((await POST(request({action:'auto_approval',enabled:'true'}))).status).toBe(400);expect(m.rpc).not.toHaveBeenCalled();
 m.scope.mockResolvedValue({user_id:id(3),role:'member',launch_at:'2026-11-09'});
 expect((await POST(request({action:'auto_approval',enabled:true}))).status).toBe(403);expect(m.rpc).not.toHaveBeenCalled();
});
