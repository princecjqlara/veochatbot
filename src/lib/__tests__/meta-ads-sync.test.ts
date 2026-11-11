import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ read: vi.fn(), connection: vi.fn() }));
vi.mock('../facebook-ad-catalog', () => ({ marketingConnection: m.connection, readMetaAds: m.read,
    creativePageId: (ad: any) => ad.creative?.page, catalogMetadata: (ad: any, page: string) => ({ page_id: page, ad_id: ad.id }) }));
import { adSpendWindows, refreshMetaAdSpend } from '../meta-ads-sync';
const pages = [{ id: 'veo', fb_page_id: '111' }, { id: 'quiet', fb_page_id: '222' }];
let db: any, saved: Record<string, any[]>, cached: any[];
beforeEach(() => {
    vi.resetAllMocks(); saved = {}; cached = [];
    const inventory: any = { in: () => inventory, order: () => inventory, range: async () => ({ data: cached }) };
    db = { rpc: vi.fn(async () => ({ error: null })), from: (table: string) => ({ select: () => inventory, upsert: vi.fn(async (rows: any[]) => { (saved[table] ||= []).push(...rows); return { error: null }; }) }) };
    m.connection.mockResolvedValue({ status: 'ready', accounts: [{ id: 'act_99' }, { id: 'act_88' }] });
    m.read.mockImplementation(async path => path === 'act_99' || path === 'act_88' ? { id: path, currency: 'PHP', timezone_name: 'Asia/Manila' }
        : path === 'act_99/ads' ? { data: [{ id: '1', account_id: '99', creative: { page: '111' } }] }
        : path.endsWith('/ads') ? { data: [] }
        : path === 'act_99/insights' ? { data: [{ ad_id: '1', account_id: '99', account_currency: 'PHP', date_start: '2025-07-01', date_stop: '2025-07-01', spend: '123.45' }] } : { data: [] });
});
const run = (extra: any = {}) => refreshMetaAdSpend({ db, token: 'test-only', pages, from: '2025-07-01', to: '2025-07-02', authorize: async () => pages.map(p => p.id), ...extra });
it('splits historical dates at month boundaries and validates real dates', () => {
    expect(adSpendWindows('2025-07-30', '2025-08-02')).toEqual([{ from: '2025-07-30', to: '2025-07-31' }, { from: '2025-08-01', to: '2025-08-02' }]);
    expect(() => adSpendWindows('2025-02-30', '2025-03-02')).toThrow();
});
it('checks every account and saves real daily spend plus proven zero-spend Pages', async () => {
    const r = await run(); expect(r.complete).toBe(true); expect(r.accounts).toBe(2);
    expect(m.read.mock.calls.filter(c => c[0].endsWith('/insights'))).toHaveLength(2);
    expect(saved.ad_daily_spend).toHaveLength(2); expect(saved.ad_daily_spend[0]).toMatchObject({ amount: 123.45, page_id: 'veo' });
    expect(saved.veo_ad_spend_coverage).toHaveLength(4);
    expect(saved.veo_ad_spend_coverage.find(r => r.page_id === 'quiet')).toMatchObject({ amount_minor: 0, accounts_checked: 2, ad_count: 0, report_complete: true });
});
it('retains spend, impressions, clicks, frequency, messaging and video metrics from the hourly import',async()=>{
 const original=m.read.getMockImplementation()!;
 m.read.mockImplementation(async(path,token,params)=>{const result=await original(path,token,params);if(path==='act_99/insights')return{...result,data:result.data.map((row:any)=>({...row,impressions:'1000',clicks:'25',reach:'400',frequency:'2.5',inline_link_clicks:'20',actions:[{action_type:'onsite_conversion.messaging_conversation_started_7d',value:'5'}],video_play_actions:[{action_type:'video_view',value:'100'}],video_thruplay_watched_actions:[{action_type:'video_view',value:'60'}],video_p100_watched_actions:[{action_type:'video_view',value:'40'}]}))};return result;});
 expect((await run()).complete).toBe(true);
 expect(saved.ad_daily_spend[0]).toMatchObject({amount:123.45,impressions:1000,clicks:25,reach:400,frequency:2.5,link_clicks:20,messaging_started:5,video_plays:100,video_thruplays:60,video_complete:40});
 const fields=m.read.mock.calls.find(([path])=>path==='act_99/insights')![2].fields.split(',');for(const field of ['spend','impressions','clicks','reach','frequency','actions','video_play_actions'])expect(fields).toContain(field);
});
it('resolves old referral-only creatives even when current inventory and recent spend do not include them',async()=>{
    cached=[{page_id:'veo',ad_id:'7',ad_account_id:null}];
    m.read.mockImplementation(async path=>path==='act_99'||path==='act_88'?{id:path,currency:'PHP',timezone_name:'Asia/Manila'}:path==='7'?{id:'7',account_id:'99',effective_status:'PAUSED',creative:{page:'111'}}:{data:[]});
    const result=await run();expect(result.complete).toBe(true);expect(db.rpc).toHaveBeenCalledWith('save_ad_catalog_metadata',{p_records:[{page_id:'veo',ad_id:'7'}]});
    expect(saved.ad_daily_spend.filter(row=>row.ad_id==='7')).toHaveLength(2);
});
it('does not certify no-ads budgets or zero spend when a known referral creative is outside connected account scope',async()=>{
    cached=[{page_id:'veo',ad_id:'7',ad_account_id:null}];
    m.read.mockImplementation(async path=>path==='act_99'||path==='act_88'?{id:path,currency:'PHP',timezone_name:'Asia/Manila'}:path==='7'?{id:'7',account_id:'777',creative:{page:'111'}}:{data:[]});
    const result=await run();expect(result.complete).toBe(false);expect(saved.veo_ad_planning_state).toBeUndefined();expect(saved.veo_ad_spend_coverage).toBeUndefined();
});
it('does not certify partial account reports or guess ownership of deleted ads', async () => {
    m.read.mockImplementation(async path => path.startsWith('act_') && !path.includes('/') ? { id: path, currency: 'PHP', timezone_name: 'Asia/Manila' }
        : path.endsWith('/ads') ? { data: [] } : path.endsWith('/insights') ? { data: [{ ad_id: '9' }] } : { id: '9', account_id: '99', creative: {} });
    const r = await run(); expect(r.complete).toBe(false); expect(saved.veo_ad_spend_coverage).toBeUndefined();
});
it('resolves archived ad creative ownership instead of dropping historical spend', async () => {
    const initial = m.read.getMockImplementation()!;
    m.read.mockImplementation(async (path, ...args) => path === 'act_99/ads' ? { data: [] } : path === '1' ? { id: '1', account_id: '99', creative: { page: '111' } } : initial(path, ...args));
    expect((await run()).complete).toBe(true); expect(m.read).toHaveBeenCalledWith('1', 'test-only', expect.any(Object));
    expect(saved.ad_daily_spend[0].amount).toBe(123.45);
});
it('blocks coverage when Meta repeats a cursor or Page access is revoked', async () => {
    const initial = m.read.getMockImplementation()!;
    m.read.mockImplementation(async (path, ...args) => path.endsWith('/insights') ? { data: [], paging: { next: 'present', cursors: { after: 'same' } } } : initial(path, ...args));
    expect((await run()).complete).toBe(false); expect(saved.veo_ad_spend_coverage).toBeUndefined();
    expect((await run({ authorize: async () => ['veo'] })).complete).toBe(false);
});
it('does not report an incomplete account inventory as complete', async () => {
    m.connection.mockResolvedValue({ status: 'ready', partial: true, accounts: [{ id: 'act_99' }] });
    expect((await run()).complete).toBe(false); expect(m.read).not.toHaveBeenCalled();
});
it('retains historically verified creatives on later refreshes, even when current inventory omits them', async () => {
    cached = [{ page_id: 'veo', ad_id: '5', ad_account_id: '99' }];
    expect((await run()).complete).toBe(true);
    expect(saved.ad_daily_spend.filter(r => r.ad_id === '5')).toHaveLength(2);
    expect(saved.veo_ad_spend_coverage.find(r => r.page_id === 'veo' && r.spend_date === '2025-07-01').ad_count).toBe(2);
});
