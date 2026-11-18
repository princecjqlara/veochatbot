import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ guard: vi.fn(), read: vi.fn(), from: vi.fn(), rpc: vi.fn(), session: vi.fn(), scope: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/veo-workspace', () => ({ workspaceScope: m.scope, uuid: (value: any) => typeof value === 'string' && value.length === 36 }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => m }));
vi.mock('@/lib/veo-contact-identity-sync', () => ({ readContactIdentityBatch: m.read }));
vi.mock('@/lib/veo-storage-health', () => ({ requireStorageForOptionalWork: m.guard }));
import { POST } from './route';
const page = '00000000-0000-4000-8000-000000000001';
const request = (body: any = { page_id: page }, origin = 'https://veo.test') => new NextRequest('https://veo.test/api/workspace/contacts/sync', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
beforeEach(() => {
    vi.resetAllMocks();m.session.mockResolvedValue({ user: { id: 'actor' } });m.scope.mockResolvedValue({ user_id: 'actor', role: 'member', launch_at: '2026-11-05', page_ids: [page] });
    m.guard.mockResolvedValue({});m.read.mockResolvedValue({contacts:[{psid:'123',name:'Client'}],next_cursor:'next'});
    const q:any={select:()=>q,eq:()=>q,single:async()=>({data:{fb_page_id:'111',access_token:'owner-page-secret'}})};m.from.mockReturnValue(q);
    m.rpc.mockImplementation(async name=>({data:name==='veo_seed_contact_identities'?{inserted:1,skipped:0,updated_names:0}:true}));
});
it.each(['member','manager','team_leader','owner'])('allows %s to sync assigned Pages through the stored Owner token without impersonating the Owner',async role=>{
    m.scope.mockResolvedValue({user_id:'actor',role,launch_at:'2026-11-05',page_ids:[page]});
    const response=await POST(request({page_id:page,cursor:'earlier',access_token:'forged',actor_id:'forged-owner'}));
    expect(response.status).toBe(200);const body=await response.json();expect(body).toMatchObject({inserted:1,next_cursor:'next',complete:false});expect(JSON.stringify(body)).not.toContain('secret');
    expect(m.read).toHaveBeenCalledWith({fb_page_id:'111',access_token:'owner-page-secret'},'earlier',expect.any(AbortSignal));
    expect(m.rpc).toHaveBeenCalledWith('veo_seed_contact_identities',{p_actor:'actor',p_page:page,p_contacts:[{psid:'123',name:'Client'}]});
    expect(m.rpc).toHaveBeenCalledWith('release_page_sync_lease',expect.objectContaining({p_page_id:page}));
});
it('does not read provider history or save a batch when storage is critical or monitoring is stale', async () => {
    m.guard.mockRejectedValueOnce(Object.assign(Error('Bulk processing paused for storage attention'), { status: 503, code: 'STORAGE_ATTENTION' }));
    const response = await POST(request());expect(response.status).toBe(503);expect((await response.json()).code).toBe('STORAGE_ATTENTION');expect(response.headers.get('Retry-After')).toBe('300');expect(m.from).not.toHaveBeenCalled();expect(m.read).not.toHaveBeenCalled();
});
it('rejects unassigned Pages before any credential, storage or provider work', async () => {
    m.scope.mockResolvedValueOnce({user_id:'actor',role:'manager',launch_at:'launched',page_ids:[]});expect((await POST(request())).status).toBe(403);expect(m.guard).not.toHaveBeenCalled();expect(m.from).not.toHaveBeenCalled();
});
it('reports suspended current sessions as 403 without starting a sync',async()=>{
    m.session.mockRejectedValueOnce(Object.assign(Error('Your account is suspended'),{status:403,code:'ACCOUNT_SUSPENDED'}));
    const r=await POST(request());expect(r.status).toBe(403);expect((await r.json()).code).toBe('ACCOUNT_SUSPENDED');expect(m.guard).not.toHaveBeenCalled();expect(m.read).not.toHaveBeenCalled();
});
it('rechecks revoked access when saving and releases its lease without declaring success',async()=>{
    m.rpc.mockImplementation(async name=>name==='veo_seed_contact_identities'?{error:{code:'42501',message:'Denied'}}:{data:true});
    expect((await POST(request())).status).toBe(403);expect(m.rpc).toHaveBeenCalledWith('release_page_sync_lease',expect.anything());
});
it('handles provider failure with a retryable response and releases the Page lease',async()=>{
    m.read.mockRejectedValueOnce(Object.assign(Error('Facebook could not read this Page'),{status:502}));const r=await POST(request());expect(r.status).toBe(502);expect((await r.json()).retryable).toBe(true);
    expect(m.rpc.mock.calls.some(([name])=>name==='veo_seed_contact_identities')).toBe(false);expect(m.rpc).toHaveBeenCalledWith('release_page_sync_lease',expect.anything());
});
it('does not compete with an already running batch',async()=>{
    m.rpc.mockResolvedValueOnce({data:false});const r=await POST(request());expect(r.status).toBe(409);expect(r.headers.get('Retry-After')).toBe('5');expect(m.read).not.toHaveBeenCalled();
});
it('checks same-origin, signed identity, launch and cursor validation',async()=>{
    expect((await POST(request({},'https://other.test'))).status).toBe(403);expect(m.session).not.toHaveBeenCalled();
    m.session.mockResolvedValueOnce(null);expect((await POST(request())).status).toBe(401);
    m.scope.mockResolvedValueOnce(null);expect((await POST(request())).status).toBe(403);
    for(const body of [null,{page_id:'bad'},{page_id:page,cursor:'x'.repeat(2049)},{page_id:page,cursor:12}])expect((await POST(request(body))).status).toBe(400);
    expect(m.guard).not.toHaveBeenCalled();
});
