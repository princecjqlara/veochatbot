import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({connection:vi.fn()}));
vi.mock('../facebook-ad-catalog',()=>({marketingConnection:m.connection}));
import {retainWorkspaceAdsGrant} from '../veo-ads-authorization';
import {decryptMetaAdsToken} from '../meta-ads-credentials';
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('NEXTAUTH_SECRET','private-test-secret-that-is-over-32-characters');vi.stubEnv('FACEBOOK_CLIENT_ID','app');m.connection.mockResolvedValue({status:'ready',accounts:[{id:'act_1'}],permissions:['ads_read']});});
afterEach(()=>{vi.unstubAllEnvs();});
it('retains only encrypted ad-read access with its actual expiry after successful authorization',async()=>{
    const upsert=vi.fn(async()=>({data:{}})),db={from:vi.fn(()=>({upsert}))},exchange=vi.fn(async()=>({access_token:'private-long-token',expires_in:3600}));
    await retainWorkspaceAdsGrant(db,'owner','private-short-token',exchange);
    expect(db.from).toHaveBeenCalledWith('meta_ads_credentials');const saved=upsert.mock.calls[0] as any;
    expect(decryptMetaAdsToken(saved[0])).toBe('private-long-token');expect(JSON.stringify(saved)).not.toContain('private-long-token');expect(Date.parse(saved[0].token_expires_at)-Date.now()).toBeGreaterThan(3590000);
    expect(saved[0].sync_checkpoint).toMatchObject({completed_windows:[],page_ids:[],account_ids:[]});expect(Date.parse(saved[0].sync_checkpoint.to)-Date.parse(saved[0].sync_checkpoint.from)).toBe(14*86400000);
});
it('accepts a verified token when Meta omits expires_in and uses its actual data-access deadline',async()=>{
 const expires=Math.floor(Date.now()/1000)+86400,dataExpiry=expires-3600,upsert=vi.fn(async(_value:any,_options?:any)=>({data:{}})),db={from:()=>({upsert})};
 await retainWorkspaceAdsGrant(db,'owner','short',async()=>({access_token:'verified-long-token'}),async()=>({data:{is_valid:true,app_id:'app',type:'USER',expires_at:expires,data_access_expires_at:dataExpiry}}));
 expect(upsert.mock.calls[0][0].token_expires_at).toBe(new Date(dataExpiry*1000).toISOString());
});
it.each([{is_valid:false,app_id:'app',type:'USER'},{is_valid:true,app_id:'foreign',type:'USER'},{is_valid:true,app_id:'app',type:'PAGE'}])('rejects unverified or Page tokens without replacing saved access',async metadata=>{
 const db={from:vi.fn()};await expect(retainWorkspaceAdsGrant(db,'owner','short',async()=>({access_token:'long',expires_in:3600}),async()=>({data:metadata}))).rejects.toMatchObject({code:'ADS_TOKEN_INVALID'});expect(db.from).not.toHaveBeenCalled();
});
it('does not invent an expiry when neither the exchange nor verified token metadata supplies one',async()=>{
 const db={from:vi.fn()};await expect(retainWorkspaceAdsGrant(db,'owner','short',async()=>({access_token:'long'}),async()=>({data:{is_valid:true,app_id:'app',type:'USER'}}))).rejects.toMatchObject({code:'ADS_TOKEN_EXPIRY_UNAVAILABLE'});expect(db.from).not.toHaveBeenCalled();
});
it('reports temporary extension failures separately from missing ad permission',async()=>{
 await expect(retainWorkspaceAdsGrant({from:vi.fn()},'owner','short',async()=>{throw Error('private upstream detail');})).rejects.toMatchObject({code:'ADS_TOKEN_EXCHANGE_FAILED',status:503});
});
it.each([{status:'permission_required',accounts:[]},{status:'ready',accounts:[]},{status:'ready',accounts:[{id:'act_1'}],partial:true}])('keeps previous credentials when account read consent is incomplete',async connection=>{
    m.connection.mockResolvedValue(connection);const db={from:vi.fn()},exchange=vi.fn();
    await expect(retainWorkspaceAdsGrant(db,'owner','short',exchange)).rejects.toMatchObject({code:'ADS_ACCESS_REQUIRED'});expect(exchange).not.toHaveBeenCalled();expect(db.from).not.toHaveBeenCalled();
});
