import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({connection:vi.fn()}));
vi.mock('../facebook-ad-catalog',()=>({marketingConnection:m.connection}));
import {retainWorkspaceAdsGrant} from '../veo-ads-authorization';
import {decryptMetaAdsToken} from '../meta-ads-credentials';
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('NEXTAUTH_SECRET','private-test-secret-that-is-over-32-characters');m.connection.mockResolvedValue({status:'ready',accounts:[{id:'act_1'}],permissions:['ads_read']});});
afterEach(()=>{vi.unstubAllEnvs();});
it('retains only encrypted ad-read access with its actual expiry after successful authorization',async()=>{
    const upsert=vi.fn(async()=>({data:{}})),db={from:vi.fn(()=>({upsert}))},exchange=vi.fn(async()=>({access_token:'private-long-token',expires_in:3600}));
    await retainWorkspaceAdsGrant(db,'owner','private-short-token',exchange);
    expect(db.from).toHaveBeenCalledWith('meta_ads_credentials');const saved=upsert.mock.calls[0] as any;
    expect(decryptMetaAdsToken(saved[0])).toBe('private-long-token');expect(JSON.stringify(saved)).not.toContain('private-long-token');expect(Date.parse(saved[0].token_expires_at)-Date.now()).toBeGreaterThan(3590000);
});
it.each([{status:'permission_required',accounts:[]},{status:'ready',accounts:[]},{status:'ready',accounts:[{id:'act_1'}],partial:true}])('keeps previous credentials when account read consent is incomplete',async connection=>{
    m.connection.mockResolvedValue(connection);const db={from:vi.fn()},exchange=vi.fn();
    await expect(retainWorkspaceAdsGrant(db,'owner','short',exchange)).rejects.toMatchObject({code:'ADS_ACCESS_REQUIRED'});expect(exchange).not.toHaveBeenCalled();expect(db.from).not.toHaveBeenCalled();
});
