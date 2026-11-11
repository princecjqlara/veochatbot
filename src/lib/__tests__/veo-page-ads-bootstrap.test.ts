import {beforeEach,afterEach,expect,it,vi}from'vitest';
const m=vi.hoisted(()=>({inspect:vi.fn(),connection:vi.fn()}));
vi.mock('../facebook-ad-catalog',()=>({inspectPageAdGrant:m.inspect,marketingConnection:m.connection}));
import{bootstrapPageAds}from'../veo-page-ads-bootstrap';import{decryptMetaAdsToken}from'../meta-ads-credentials';
let db:any,existing:any,pages:any[],upsert:any,mark:any,claim:any,authorize:any;
beforeEach(()=>{
 vi.clearAllMocks();vi.stubEnv('NEXTAUTH_SECRET','fixture-secret-for-encrypted-page-access-over-32-characters');existing=null;pages=[{id:'page',fb_page_id:'111',access_token:'private-page-token'}];
 upsert=vi.fn(async()=>({error:null}));mark=vi.fn(()=>({eq:async()=>({error:null})}));claim=vi.fn(async()=>({data:true}));authorize=vi.fn(async()=>['page']);
 const read:any={eq:()=>read,maybeSingle:async()=>({data:existing})},scoped:any={in:()=>scoped,eq:()=>scoped,order:async()=>({data:pages})};
 db={rpc:claim,from:(table:string)=>table==='meta_ads_credentials'?{select:()=>read,upsert}:table==='pages'?{select:()=>scoped}:{update:mark}};
 m.inspect.mockResolvedValue({permissions:['ads_read'],expires_at:null});m.connection.mockResolvedValue({status:'ready',accounts:[{id:'act_1'}]});
});afterEach(()=>{vi.unstubAllEnvs();});
const run=()=>bootstrapPageAds({db,user:'owner',authorize});
it('automatically retains verified current Page read access encrypted without replacing a concurrent connection',async()=>{
 const result=await run();expect(result).toMatchObject({connected:true,accounts:1,credential_origin:'connected_page'});expect(m.inspect).toHaveBeenCalledWith('private-page-token','111');expect(authorize).toHaveBeenCalledTimes(2);
 const saved=upsert.mock.calls[0];expect(decryptMetaAdsToken(saved[0])).toBe('private-page-token');expect(JSON.stringify(saved)).not.toContain('private-page-token');expect(saved[0]).toMatchObject({user_id:'owner',source_page_id:'page',credential_origin:'connected_page',permissions:['ads_read']});expect(saved[1]).toEqual({onConflict:'user_id',ignoreDuplicates:true});expect(JSON.stringify(result)).not.toContain('token');
});
it('preserves an existing ad connection without attempting another discovery',async()=>{
 existing={user_id:'owner'};expect(await run()).toMatchObject({connected:true,existing:true});expect(claim).not.toHaveBeenCalled();expect(m.inspect).not.toHaveBeenCalled();expect(upsert).not.toHaveBeenCalled();
});
it('does not contact Meta until an authorized hourly discovery claim is acquired',async()=>{
 claim.mockResolvedValueOnce({data:false});expect(await run()).toMatchObject({connected:false,skipped:true});expect(m.inspect).not.toHaveBeenCalled();claim.mockResolvedValueOnce({error:{code:'42501'}});await expect(run()).rejects.toMatchObject({status:403});expect(upsert).not.toHaveBeenCalled();
});
it.each([{status:'ready',accounts:[]},{status:'ready',accounts:[{id:'act_1'}],partial:true},{status:'permission_required',accounts:[]}])('does not retain incomplete account discovery (%s)',async connection=>{
 m.connection.mockResolvedValue(connection);await expect(run()).rejects.toMatchObject({status:409});expect(upsert).not.toHaveBeenCalled();expect(mark).toHaveBeenCalledWith(expect.objectContaining({status:'failed'}));
});
it('rejects Page access revoked while verifying capabilities and tries another invalid Page without exposing its token',async()=>{
 authorize.mockResolvedValueOnce(['page']).mockResolvedValueOnce([]);await expect(run()).rejects.toThrow('Page access changed');expect(upsert).not.toHaveBeenCalled();
});
it('checks the next assigned Page if the earlier saved grant is invalid',async()=>{
 pages.push({id:'page-two',fb_page_id:'222',access_token:'second-private-token'});authorize.mockResolvedValue(['page','page-two']);m.inspect.mockRejectedValueOnce(Error('Invalid Page token'));
 expect((await run()).connected).toBe(true);expect(upsert.mock.calls[0][0].source_page_id).toBe('page-two');expect(decryptMetaAdsToken(upsert.mock.calls[0][0])).toBe('second-private-token');
});
