import {it,expect,vi,afterEach} from 'vitest';
import {queueReceiptDeletions} from '../veo-receipt-deletion';
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
function fixture(){
 const updates:any[]=[];
 const query:any={select:()=>query,is:()=>query,order:()=>query,limit:()=>query,eq:()=>query,then:(resolve:any)=>Promise.resolve({data:[{submission_id:'saved'}]}).then(resolve)};
 const db={from:()=>({...query,update:(data:any)=>({eq:async()=>{updates.push(data);return {};}})})};
 vi.stubEnv('VEO_JAUCIAN_URL','https://jaucian.test');vi.stubEnv('VEO_JAUCIAN_SECRET','secret');return {db,updates};
}
it('queues only the persisted submission identity and acknowledges a confirmed durable bot queue',async()=>{
 const {db,updates}=fixture();const fetcher=vi.fn(async(_url:any,_options:any)=>new Response(JSON.stringify({ok:true,deletion_queued:true})));vi.stubGlobal('fetch',fetcher);
 expect(await queueReceiptDeletions(db)).toEqual({queued:1,retry:false});
 expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({action:'delete_receipt',submission_id:'saved'});expect(updates[0].queued_at).toBeTruthy();
});
it('retains deletion for retry when Jaucian is unavailable or does not acknowledge deletion',async()=>{
 const {db,updates}=fixture();vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({ok:true}),{status:200})));
 expect(await queueReceiptDeletions(db)).toEqual({queued:0,retry:true});expect(updates[0].queued_at).toBeUndefined();expect(updates[0].last_error).toContain('retry');
});
