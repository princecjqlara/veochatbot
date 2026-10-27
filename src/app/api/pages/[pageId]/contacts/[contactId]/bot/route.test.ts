import{beforeEach,describe,it,expect,vi}from'vitest';import{NextRequest}from'next/server';
const m=vi.hoisted(()=>({session:vi.fn(),access:vi.fn(),db:vi.fn(),rpc:vi.fn(),found:vi.fn()}));
vi.mock('@/lib/get-session',()=>({getSessionFromRequest:m.session}));vi.mock('@/lib/page-access',()=>({userHasPageAccess:m.access}));vi.mock('@/lib/supabase',()=>({getSupabaseAdmin:m.db}));
import{PATCH}from'./route';
const params=Promise.resolve({pageId:'p',contactId:'c'}),req=(body:any,origin='https://example.com')=>new NextRequest('https://example.com/api/pages/p/contacts/c/bot',{method:'PATCH',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
describe('individual bot permission',()=>{
 beforeEach(()=>{vi.clearAllMocks();m.session.mockResolvedValue({user:{id:'member'}});m.access.mockResolvedValue(true);m.found.mockResolvedValue({data:{id:'c'},error:null});const chain:any={select:()=>chain,eq:()=>chain,maybeSingle:m.found};m.rpc.mockResolvedValue({data:{enabled:false,changed:true,cancelled_follow_ups:2},error:null});m.db.mockReturnValue({from:()=>chain,rpc:m.rpc});});
 it('does not allow a cross-origin change or a change on another Page',async()=>{
  expect((await PATCH(req({enabled:false},'https://other.example'),{params})).status).toBe(403);m.access.mockResolvedValue(false);expect((await PATCH(req({enabled:false}),{params})).status).toBe(403);expect(m.rpc).not.toHaveBeenCalled();
 });
 it('requires an actual boolean and does not pretend a missing contact was changed',async()=>{
  for(const body of [null,{enabled:'false'},{}])expect((await PATCH(req(body),{params})).status).toBe(400);
  m.found.mockResolvedValue({data:null,error:null});expect((await PATCH(req({enabled:false}),{params})).status).toBe(404);
 });
 it('changes only the selected contact through the atomic membership-checked function',async()=>{
  const r=await PATCH(req({enabled:false}),{params});expect(r.status).toBe(200);expect(m.rpc).toHaveBeenCalledWith('set_contact_bot_permission',{p_page_id:'p',p_contact_id:'c',p_actor_id:'member',p_enabled:false});expect((await r.json()).cancelled_follow_ups).toBe(2);
 });
});
