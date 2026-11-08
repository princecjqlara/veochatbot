import { beforeEach,afterEach,expect,it,vi } from 'vitest';
import { NextRequest } from 'next/server';
const m=vi.hoisted(()=>({session:vi.fn(),scope:vi.fn(),from:vi.fn(),rpc:vi.fn(),fetch:vi.fn()}));
vi.mock('@/lib/get-session',()=>({getSessionFromRequest:m.session}));
vi.mock('@/lib/veo-workspace',()=>({workspaceScope:m.scope,uuid:(s:string)=>/^[0-9a-f-]{36}$/.test(s||'')}));
vi.mock('@/lib/supabase',()=>({getSupabaseAdmin:()=>m}));
vi.mock('@/lib/veo-business-orders',()=>({fetchBusinessOrderNotices:m.fetch}));
import {GET,POST} from './route';
const contact='00000000-0000-4000-8000-000000000001';
const req=(post=false,origin='https://veo.test')=>new NextRequest('https://veo.test/api/workspace/business-orders?contact_id='+contact,{method:post?'POST':'GET',headers:{Origin:origin}});
beforeEach(()=>{
    m.session.mockResolvedValue({user:{id:'worker'}});m.scope.mockResolvedValue({user_id:'worker',page_ids:['page'],launch_at:'2026-11-05'});
    m.rpc.mockResolvedValue({data:{items:[]}});m.fetch.mockResolvedValue({orders:[{invoice_id:'123',total_minor:10000}],complete:true,pages_checked:1,coverage:'Available notices'});
    m.from.mockImplementation((table:string)=>{const chain:any={select:()=>chain,eq:()=>chain,maybeSingle:async()=>({data:{id:contact,page_id:'page',psid:'client'}}),single:async()=>({data:table==='pages'?{fb_page_id:'123',access_token:'private'}:null})};return chain;});
});afterEach(()=>{vi.clearAllMocks();});
it('requires sign-in and Page access before reading Facebook credentials',async()=>{
    m.session.mockResolvedValue(null);expect((await GET(req())).status).toBe(401);expect(m.from).not.toHaveBeenCalled();
    m.session.mockResolvedValue({user:{id:'worker'}});m.scope.mockResolvedValue({user_id:'worker',page_ids:[],launch_at:'2026-11-05'});
    expect((await POST(req(true))).status).toBe(403);expect(m.fetch).not.toHaveBeenCalled();expect(m.from.mock.calls.map(([table])=>table)).toEqual(['contacts']);
});
it('queues a bounded background refresh and returns saved source status without tokens or messages',async()=>{
    const r=await POST(req(true)),body=await r.json();expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('no-store');expect(JSON.stringify(body)).not.toContain('private');
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.rpc).toHaveBeenCalledWith('veo_request_source_refresh',{p_actor:'worker',p_contact:contact});
    expect(m.rpc).toHaveBeenCalledWith('veo_business_orders_page',{p_actor:'worker',p_contact:contact});
    expect(m.rpc).toHaveBeenCalledWith('veo_source_page',{p_actor:'worker',p_contact:contact});
});
it('does not fetch on cached reads and fails closed when Page permission changes during a fetch',async()=>{
    expect((await GET(req())).status).toBe(200);expect(m.fetch).not.toHaveBeenCalled();
    m.rpc.mockResolvedValue({error:{code:'42501'}});expect((await POST(req(true))).status).toBe(403);
    expect((await POST(req(true,'https://other.test'))).status).toBe(403);
});
