import{afterEach,describe,it,expect,vi}from'vitest';import{act,create,type ReactTestRenderer}from'react-test-renderer';import{createElement}from'react';import ConversionPerformance from'./ConversionPerformance';
let view:ReactTestRenderer|undefined;afterEach(()=>{if(view)act(()=>view!.unmount());view=undefined;vi.unstubAllGlobals();});
const row={page_id:'p',ad_id:'123',day:'2026-10-20',page:{name:'Azshinari'},leads:10,confirmed:1,qualified:2,not_qualified:3,current_rate:.1,avg_hours:24,median_hours:24,unverified:0,newer_activity:0,forecast:{'168':{rate:.1},'336':{rate:.15},'720':{rate:.2}},period_payments:{confirmed:5,avg_hours:48,median_hours:24},target:{rate:.04,status:'already_reached',actual_hit_at:'2026-10-21T00:00:00Z',required_payers:1},spend:{amount:null,recorded_amount:null,currency:null,covered_days:0,required_days:1},cost_per_linked_inquiry:null,cost_per_confirmed_payer:null};
const data={pages:[row],ads:[row],daily:[row],unique_contacts:10,refresh_pending:0,generated_at:'2026-10-29T00:00:00Z',range:{from:'2026-10-19T16:00:00Z',to:'2026-10-20T16:00:00Z'}};
const response=(d:any)=>({ok:true,json:async()=>d});
describe('Page and creative summary display',()=>{
 it('separates period payment counts from original-cohort conversions and shows missing spend as N/A',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>response(data)));await act(async()=>{view=create(createElement(ConversionPerformance,{query:'range=30'}));});const text=JSON.stringify(view!.toJSON());expect(text).toContain('Payment confirmations in period');expect(text).toContain('Cohort payers now');expect(text).toContain('10.00%');expect(text).toContain('20.00%');expect(text).toContain('N/A');expect(text).toContain('does not assume');
 });
 it('does not replace a newer target report with an older response',async()=>{
  let finish:(v:any)=>void=()=>{};vi.stubGlobal('fetch',vi.fn((url:string)=>url.includes('target=3.5')?Promise.resolve(response({...data,pages:[{...row,page:{name:'NEW TARGET'}}]})):new Promise(resolve=>{finish=resolve;})));
  await act(async()=>{view=create(createElement(ConversionPerformance,{query:'range=30'}));});
  // Target controls appear after the first successful load, then two refreshes race.
  await act(async()=>finish(response(data)));
  let old:(v:any)=>void=()=>{};vi.stubGlobal('fetch',vi.fn((url:string)=>url.includes('target=3.5')?Promise.resolve(response({...data,pages:[{...row,page:{name:'NEW TARGET'}}]})):new Promise(resolve=>{old=resolve;})));
  act(()=>view!.root.findAllByType('button').find(b=>b.props.children==='Refresh summary')!.props.onClick());
  await act(async()=>view!.root.findAllByType('select').find(s=>s.props['aria-label']==='Target conversion rate')!.props.onChange({target:{value:'3.5'}}));
  await act(async()=>old(response({...data,pages:[{...row,page:{name:'OLD TARGET'}}]})));
  const text=JSON.stringify(view!.toJSON());expect(text).toContain('NEW TARGET');expect(text).not.toContain('OLD TARGET');
 });
 it('refreshes conversation evidence in bounded batches without any bot or customer-send request',async()=>{
  const fetch=vi.fn(async(url:string)=>response(url.includes('/refresh-evidence')?{processed:['synthetic'],failed:[],pending:0}:data));vi.stubGlobal('fetch',fetch);
  await act(async()=>{view=create(createElement(ConversionPerformance,{query:'range=30',compact:true}));});await act(async()=>view!.root.findAllByType('button').find(b=>b.props.children==='Verify latest conversations')!.props.onClick());
  expect(fetch.mock.calls.some(c=>c[0].includes('/refresh-evidence'))).toBe(true);expect(fetch.mock.calls.some(c=>/\/bot|\/send/.test(c[0]))).toBe(false);expect(JSON.stringify(view!.toJSON())).toContain('1 conversations verified');
 });
});
