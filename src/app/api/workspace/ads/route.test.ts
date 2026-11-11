import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {NextRequest} from 'next/server';
const m=vi.hoisted(()=>({session:vi.fn(),scope:vi.fn(),from:vi.fn(),authorize:vi.fn(),recover:vi.fn(),grant:vi.fn(),refresh:vi.fn(),ids:vi.fn()}));
vi.mock('@/lib/get-session',()=>({getSessionFromRequest:m.session}));
vi.mock('@/lib/veo-workspace',()=>({workspaceScope:m.scope,philippineDate:()=> '2026-11-11'}));
vi.mock('@/lib/supabase',()=>({getSupabaseAdmin:()=>({from:m.from})}));
vi.mock('@/lib/page-access',()=>({getUserPageIds:m.ids}));
vi.mock('@/lib/facebook-page-authorization',()=>({beginFacebookPageAuthorization:m.authorize,pageAuthorizationConfigured:()=>true,readFacebookPageGrant:m.grant,recoverFacebookAdsAuthorization:m.recover}));
vi.mock('@/lib/veo-stored-ads-refresh',()=>({refreshStoredWorkspaceAds:m.refresh}));
import {GET,POST} from './route';
beforeEach(()=>{vi.clearAllMocks();m.session.mockResolvedValue({user:{id:'owner'}});m.scope.mockResolvedValue({user_id:'owner',role:'owner',tenant_id:'tenant',launch_at:'2026-11-09',page_ids:['page']});m.refresh.mockResolvedValue({complete:true,errors:[]});m.authorize.mockResolvedValue(Response.json({authorizationUrl:'https://www.facebook.com/dialog/oauth'}));
 m.from.mockImplementation((table:string)=>{const q:any={select:()=>q,eq:()=>q,in:()=>q,single:async()=>({data:{owner_id:'owner'}}),maybeSingle:async()=>({data:null}),then:(resolve:any)=>resolve({count:0})};return q;});});
afterEach(()=>{vi.unstubAllEnvs();});
const post=(body:any,origin='https://veo.test')=>POST(new NextRequest('https://veo.test/api/workspace/ads',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)}));
it('reports missing advertising access honestly without reading tokens or claiming that referral ads are fetched inventory',async()=>{
 const response=await GET(new NextRequest('https://veo.test/api/workspace/ads'));expect(response.status).toBe(200);expect(await response.json()).toMatchObject({status:'connect_required',verified_inventory_ads:0,last_synced_at:null,can_manage:true});expect(response.headers.get('cache-control')).toBe('no-store');expect(m.refresh).not.toHaveBeenCalled();
});
it('exposes only pending-grant availability and allows Owner recovery through the same-origin endpoint',async()=>{
 m.grant.mockResolvedValue({token:'private-token'});m.recover.mockResolvedValue(Response.json({connected:true}));const response=await GET(new NextRequest('https://veo.test/api/workspace/ads'));
 const body=await response.json();expect(body.pending_authorization).toBe(true);expect(JSON.stringify(body)).not.toContain('private-token');expect(body.sync_interval_minutes).toBe(60);
 expect((await post({action:'recover'})).status).toBe(200);expect(m.recover).toHaveBeenCalledOnce();
 expect((await post({action:'recover'},'https://other.test')).status).toBe(403);
});
it('requires Owner and same-origin for authorization and fetching, while allowing a leader to read status',async()=>{
 expect((await post({action:'authorize'},'https://other.test')).status).toBe(403);expect(m.authorize).not.toHaveBeenCalled();
 m.scope.mockResolvedValue({role:'team_leader',launch_at:'2026-11-09',page_ids:['page']});expect((await post({action:'authorize'})).status).toBe(403);
 m.session.mockResolvedValue(null);expect((await GET(new NextRequest('https://veo.test/api/workspace/ads'))).status).toBe(401);
});
it('starts a separate ad-read grant and rejects invalid or future fetch dates before source access',async()=>{
 expect((await post({action:'authorize'})).status).toBe(200);expect(m.authorize).toHaveBeenCalledWith(expect.anything(),'ads');
 for(const [from,to]of[['2026-02-30','2026-03-01'],['2026-11-09','2026-11-12'],['2026-11-11','2026-11-09']])expect((await post({action:'refresh',from,to})).status).toBe(400);expect(m.refresh).not.toHaveBeenCalled();
});
it('returns partial source reads as incomplete and rechecks current Page scope throughout fetching',async()=>{
 m.ids.mockResolvedValue(['page']);let response=await post({action:'refresh',from:'2026-11-09',to:'2026-11-10'});expect(response.status).toBe(200);expect((await response.json()).budgets_changed).toBe(0);expect(await m.refresh.mock.calls[0][0].authorize()).toEqual(['page']);
 m.refresh.mockResolvedValue({complete:false,errors:['Missing account data']});response=await post({action:'refresh',from:'2026-11-09',to:'2026-11-10'});expect(response.status).toBe(503);expect((await response.json()).complete).toBe(false);
});
