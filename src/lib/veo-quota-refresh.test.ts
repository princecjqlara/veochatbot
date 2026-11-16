import {afterEach,expect,it,vi} from 'vitest';
import {refreshQuotaSnapshots} from './veo-quota-refresh';
afterEach(()=>{vi.useRealTimers();});
const jobs=[{user_id:'a',lease_token:'one'},{user_id:'b',lease_token:'two'}];
it('commits worker updates through separate RPCs and retains successful work when a later request times out',async()=>{
    const committed:string[]=[];const db={rpc:vi.fn(async(name:string,args:any)=>{
        if(name==='veo_claim_quota_refresh')return{data:jobs};
        if(args.p_user==='b')return{error:{code:'57014'}};
        committed.push(args.p_user);return{data:{ok:true}};
    })};
    await expect(refreshQuotaSnapshots(db)).rejects.toThrow('resume');expect(committed).toEqual(['a']);
    expect(db.rpc.mock.calls.filter(([name])=>name==='veo_refresh_worker_quota').map(([,args])=>args.p_user)).toEqual(['a','b']);
});
it('continues other workers after a recorded business-rule failure and never replays that worker',async()=>{
    const db={rpc:vi.fn().mockResolvedValueOnce({data:jobs}).mockResolvedValueOnce({data:{ok:false,retryable:true}}).mockResolvedValueOnce({data:{ok:true}}).mockResolvedValueOnce({data:[]})};
    expect(await refreshQuotaSnapshots(db)).toEqual({workers:1,failed:1,deferred:false});expect(db.rpc).toHaveBeenCalledTimes(4);
});
it('stops before starting another worker when the run budget cannot cover its deadline',async()=>{
    vi.useFakeTimers();vi.setSystemTime(0);
    const db={rpc:vi.fn(async(name:string)=>{if(name==='veo_claim_quota_refresh')return{data:jobs};vi.setSystemTime(17000);return{data:{ok:true}};})};
    expect(await refreshQuotaSnapshots(db,20000)).toEqual({workers:1,failed:0,deferred:true});expect(db.rpc).toHaveBeenCalledTimes(2);
});
it('defers the remaining work after a worker records database pressure',async()=>{
    const db={rpc:vi.fn().mockResolvedValueOnce({data:jobs}).mockResolvedValueOnce({data:{ok:false,overloaded:true}})};
    expect(await refreshQuotaSnapshots(db)).toEqual({workers:0,failed:1,deferred:true});expect(db.rpc).toHaveBeenCalledTimes(2);
});
it('rechecks pressure between batches and retains already committed progress when it pauses',async()=>{
    const db={rpc:vi.fn().mockResolvedValueOnce({data:jobs}).mockResolvedValue({data:{ok:true}})};
    const guard=vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(Error('Low memory'));
    expect(await refreshQuotaSnapshots(db,90000,guard)).toEqual({workers:2,failed:0,deferred:true,paused:true});
    expect(db.rpc).toHaveBeenCalledTimes(3);expect(guard).toHaveBeenCalledTimes(2);
});
