import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({refresh:vi.fn(),decrypt:vi.fn()}));
vi.mock('../meta-ads-sync',()=>({refreshMetaAdSpend:m.refresh}));
vi.mock('../meta-ads-credentials',()=>({decryptMetaAdsToken:m.decrypt}));
import {refreshStoredWorkspaceAds} from '../veo-stored-ads-refresh';
let credential:any,db:any,pageQuery:any,writes:any[];
beforeEach(()=>{
    vi.resetAllMocks();writes=[];credential={token_expires_at:new Date(Date.now()+3600000).toISOString(),sync_checkpoint:{from:'2026-11-01',to:'2026-11-02',completed_windows:['old'],page_ids:['page'],account_ids:['act_1']}};
    m.decrypt.mockReturnValue('private-token');m.refresh.mockResolvedValue({complete:true,errors:[],completed_windows:[],page_ids:['page'],account_ids:['act_1']});
    pageQuery={in:vi.fn(()=>pageQuery),eq:vi.fn(()=>pageQuery),then:(resolve:any)=>resolve({data:[{id:'page',fb_page_id:'111'}]})};
    const read:any={eq:()=>read,maybeSingle:async()=>({data:credential})};
    const write:any={eq:vi.fn(()=>write),then:(resolve:any)=>resolve({error:null})};
    db={rpc:vi.fn(async()=>({data:true})),from:vi.fn((table:string)=>({select:()=>table==='pages'?pageQuery:read,update:(value:any)=>{writes.push(value);return write;}}))};
});
const run=()=>refreshStoredWorkspaceAds({db,user:'owner',from:'2026-11-01',to:'2026-11-02',authorize:async()=>['page']});
it('uses current enabled Page scope, a single-user lease and resumable windows without exposing tokens',async()=>{
    await run();expect(pageQuery.eq).toHaveBeenCalledWith('veo_enabled',true);expect(db.rpc).toHaveBeenCalledWith('veo_claim_meta_ads_refresh',expect.objectContaining({p_user:'owner'}));
    expect(m.refresh.mock.calls[0][0]).toMatchObject({completed:['old'],completedPages:['page'],completedAccounts:['act_1']});
    expect(writes[0]).toMatchObject({sync_checkpoint:null,last_error:null,refresh_lease_token:null});expect(JSON.stringify(writes)).not.toContain('private-token');
});
it('does not fetch without an unexpired credential or when another request holds the lease',async()=>{
    credential=null;await expect(run()).rejects.toMatchObject({status:409,requiresReconnect:true});expect(m.refresh).not.toHaveBeenCalled();
    credential={token_expires_at:new Date(Date.now()+3600000).toISOString()};db.rpc.mockResolvedValue({data:false});await expect(run()).rejects.toMatchObject({status:409});expect(m.refresh).not.toHaveBeenCalled();
});
it('retains partial progress and releases the lease after a failed or interrupted source read',async()=>{
    m.refresh.mockResolvedValue({complete:false,errors:['Incomplete source'],completed_windows:['one'],page_ids:['page'],account_ids:['act_1']});
    await run();expect(writes[0]).toMatchObject({last_error:'Incomplete source',sync_checkpoint:{completed_windows:['one']}});expect(writes[0].last_synced_at).toBeUndefined();
    m.refresh.mockRejectedValue(Error('Network failed'));await expect(run()).rejects.toThrow('Network failed');expect(writes.at(-1)).toEqual({refresh_lease_token:null,refresh_lease_until:null});
});
