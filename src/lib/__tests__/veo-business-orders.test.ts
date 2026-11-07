import { afterEach, expect, it, vi } from 'vitest';
import { fetchBusinessOrderNotices, parseBusinessOrderNotice, parseBusinessStageNotice } from '../veo-business-orders';
const launch = '2026-11-05T00:00:00Z',at = '2026-11-06T01:00:00Z';
const notice = { id:'message',from:{id:'page'},created_time:at,message:'You created an order for PHP1,299.50. View: fb-pma://payments/orderdetails/?invoice_id=12345' };
afterEach(() => { vi.unstubAllGlobals(); });
it('accepts explicit Page stage notices only, and does not mistake orders or customer text for qualification', () => {
    const stage = { ...notice, message: 'Lead stage set to Qualified.' };
    expect(parseBusinessStageNotice(stage, 'page', launch)?.stage).toBe('qualified');
    expect(parseBusinessStageNotice({ ...stage, message: 'Lead stage set to Not Qualified.' }, 'page', launch)?.stage).toBe('not_qualified');
    expect(parseBusinessStageNotice({ ...stage, message: 'Lead stage set to A new unknown label.' }, 'page', launch)?.stage).toBe('unknown');
    for (const m of [notice, { ...stage, from: { id: 'client' } }, { ...stage, created_time: '2026-11-01' }, { ...stage, created_time: '2099-01-01' }]) expect(parseBusinessStageNotice(m, 'page', launch)).toBeNull();
});
it('uses the newest explicit stage across message pages, including a later disqualification', async () => {
    const newer = { ...notice, id: 'later', message: 'Lead stage set to Not Qualified.', created_time: '2026-11-06T02:00:00Z' };
    const older = { ...notice, id: 'earlier', message: 'Lead stage set to Qualified.' };
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(++calls === 1 ? { data: [{ participants: { data: [{ id: 'client' }] }, messages: { data: [notice, newer], paging: { next: 'https://graph.facebook.com/messages?after=1' } } }] } : { data: [older] }))));
    expect((await fetchBusinessOrderNotices({ pageId: 'page', psid: 'client', token: 'private', launchAt: launch })).stage?.stage).toBe('not_qualified');
});
it('extracts invoice and exact total only from Page-authored Facebook notices since launch', () => {
    expect(parseBusinessOrderNotice(notice,'page',launch)).toMatchObject({invoice_id:'12345',total_minor:129950,currency:'PHP'});
    expect(parseBusinessOrderNotice({...notice,message:'You requested ₱699. View: fb-pma://payments/orderdetails/?invoice_id=99'},'page',launch)?.total_minor).toBe(69900);
    for(const m of [{...notice,from:{id:'customer'}},{...notice,created_time:'2026-11-01'},{...notice,message:'Please create order for PHP100'},{...notice,message:notice.message.replace('1,299.50','12,99')},{...notice,message:notice.message.replace('fb-pma:','https:')}]) expect(parseBusinessOrderNotice(m,'page',launch)).toBeNull();
});
it('fetches the chosen participant only and never treats a notice as paid',async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({data:[{id:'thread',participants:{data:[{id:'client'},{id:'page'}]},messages:{data:[notice]}}]})));vi.stubGlobal('fetch',fetcher);
    const r=await fetchBusinessOrderNotices({pageId:'page',psid:'client',token:'private',launchAt:launch});expect(r.orders).toHaveLength(1);expect(r.complete).toBe(true);expect(r.orders[0]).not.toHaveProperty('paid_minor');
    const [url,options]=fetcher.mock.calls[0] as unknown as [URL,any];expect(url.searchParams.get('user_id')).toBe('client');expect(url.searchParams.has('access_token')).toBe(false);expect(options.headers.Authorization).toBe('Bearer private');
});
it('rejects foreign pagination URLs and reports partial scans honestly',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({data:[{participants:{data:[{id:'client'}]},messages:{data:[notice],paging:{next:'https://evil.test/steal'}}}]}))));
    await expect(fetchBusinessOrderNotices({pageId:'page',psid:'client',token:'private',launchAt:launch})).rejects.toThrow(/pagination/);
    let calls=0;vi.stubGlobal('fetch',vi.fn(async()=>{calls++;return new Response(JSON.stringify(calls===1?{data:[{participants:{data:[{id:'client'}]},messages:{data:[notice],paging:{next:'https://graph.facebook.com/thread/messages?after=1'}}}]}:{data:[notice],paging:{next:'https://graph.facebook.com/thread/messages?after='+calls}}));}));
    const r=await fetchBusinessOrderNotices({pageId:'page',psid:'client',token:'private',launchAt:launch});expect(r.complete).toBe(false);expect(r.orders).toHaveLength(1);expect(calls).toBe(5);
});
