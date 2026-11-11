import { afterEach, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({read:vi.fn()}));
vi.mock('../veo-report-read',()=>({readVeoRpc:m.read}));
import { queueReviewedDelivery } from '../veo-reviewed-delivery';
afterEach(()=>{vi.resetAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
const configured=()=>{vi.stubEnv('VEO_JAUCIAN_URL','https://jaucian.test');vi.stubEnv('VEO_JAUCIAN_SECRET','test-key');};
it('keeps staff pending and missing-setup receipts out of the bot queue',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);expect(await queueReviewedDelivery({}, {status:'pending'})).toEqual({state:'awaiting_review'});
 expect(await queueReviewedDelivery({}, {status:'approved'})).toEqual({state:'waiting_for_setup'});expect(m.read).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
});
it.each(['closed','done'])('queues an authorized %s receipt immediately using current server facts',async kind=>{
 configured();const db={},facts={submission_id:'saved',receipt_kind:kind,review_status:'approved'};m.read.mockResolvedValue({data:facts});
 const fetcher=vi.fn(async(_url:unknown,_options?:any)=>new Response(JSON.stringify({ok:true,status:'pending'})));vi.stubGlobal('fetch',fetcher);
 expect(await queueReviewedDelivery(db,{status:'approved',delivery_submission:'saved'})).toEqual({state:'queued'});
 expect(m.read).toHaveBeenCalledWith(db,'veo_handoff',{p_submission:'saved'},6000);expect(fetcher).toHaveBeenCalledOnce();
 expect(String(fetcher.mock.calls[0][0])).toBe('https://jaucian.test/api/veo/handoff');expect(JSON.parse((fetcher.mock.calls[0] as any)[1].body)).toEqual(facts);
});
it('retains the durable retry path when the bot is unavailable after the deal was saved',async()=>{
 configured();m.read.mockResolvedValue({data:{submission_id:'saved'}});vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('Network unavailable')));
 expect(await queueReviewedDelivery({}, {status:'approved',delivery_submission:'saved'})).toEqual({state:'retry_scheduled'});
});
it('rechecks changed eligibility and suppresses attempts requiring reconciliation',async()=>{
 configured();m.read.mockResolvedValueOnce({data:null});const fetcher=vi.fn(async()=>new Response(JSON.stringify({ok:true,status:'cancelled'})));vi.stubGlobal('fetch',fetcher);
 expect(await queueReviewedDelivery({}, {status:'approved',delivery_submission:'saved'})).toEqual({state:'retry_scheduled'});expect(fetcher).not.toHaveBeenCalled();
 m.read.mockResolvedValueOnce({data:{submission_id:'saved'}});expect(await queueReviewedDelivery({}, {status:'approved',delivery_submission:'saved'})).toEqual({state:'needs_attention'});
});
