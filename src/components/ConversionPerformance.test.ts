import{afterEach,describe,it,expect,vi}from'vitest';import{act,create,type ReactTestRenderer}from'react-test-renderer';import{createElement}from'react';import ConversionPerformance from'./ConversionPerformance';
let view:ReactTestRenderer|undefined;afterEach(()=>{if(view)act(()=>view!.unmount());view=undefined;vi.unstubAllGlobals();});
const row={page_id:'p',ad_id:'123',day:'2026-10-20',page:{name:'Azshinari'},leads:10,confirmed:1,qualified:2,not_qualified:3,current_rate:.1,avg_hours:24,median_hours:24,unverified:0,newer_activity:0,forecast:{'168':{rate:.1},'336':{rate:.15},'720':{rate:.2}},period_payments:{confirmed:5,avg_hours:48,median_hours:24},outlook:{status:'estimated',expected_rate:.2,expected_payers:2,expected_additional_payers:1,unknown_sources:0,horizon_end_dates_pht:['2026-11-19','2026-11-19']},spend:{amount:null,recorded_amount:null,currency:null,covered_days:0,required_days:1},cost_per_linked_inquiry:null,cost_per_confirmed_payer:null};
const data={pages:[row],ads:[row],daily:[row],unique_contacts:10,refresh_pending:0,generated_at:'2026-10-29T00:00:00Z',range:{from:'2026-10-19T16:00:00Z',to:'2026-10-20T16:00:00Z'}};
const response=(d:any)=>({ok:true,json:async()=>d});
describe('Page and creative summary display',()=>{
 it('separates period payment counts from original-cohort conversions and shows missing spend as N/A',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>response(data)));await act(async()=>{view=create(createElement(ConversionPerformance,{query:'range=30'}));});const text=JSON.stringify(view!.toJSON());expect(text).toContain('Payment confirmations in period');expect(text).toContain('Cohort payers now');expect(text).toContain('10.00%');expect(text).toContain('20.00%');expect(text).toContain('N/A');expect(text).toContain('Future inquiry volume is not assumed');
 });
 it('shows expected rate and payer counts without a target selector or target request parameter',async()=>{
  const fetch=vi.fn(async(_url:string)=>response(data));vi.stubGlobal('fetch',fetch);await act(async()=>{view=create(createElement(ConversionPerformance,{query:'range=30'}));});
  const text=JSON.stringify(view!.toJSON());expect(text).toContain('Expected cohort outcome');expect(text).toContain('2026-11-19');expect(text).toContain('additional by each lead’s Day 30');expect(text).not.toContain('Target conversion rate');expect(view!.root.findAllByType('select').every(s=>s.props['aria-label']!=='Target conversion rate')).toBe(true);expect(fetch.mock.calls.every(c=>!String(c[0]).includes('target='))).toBe(true);
 });
 it('does not replace a newer date report with an older response',async()=>{
  let old:(v:any)=>void=()=>{};vi.stubGlobal('fetch',vi.fn((url:string)=>url.includes('range=7')?Promise.resolve(response({...data,pages:[{...row,page:{name:'NEW RANGE'}}]})):new Promise(resolve=>{old=resolve;})));
  await act(async()=>{view=create(createElement(ConversionPerformance,{query:'range=30'}));});await act(async()=>view!.update(createElement(ConversionPerformance,{query:'range=7'})));await act(async()=>old(response({...data,pages:[{...row,page:{name:'OLD RANGE'}}]})));
  const text=JSON.stringify(view!.toJSON());expect(text).toContain('NEW RANGE');expect(text).not.toContain('OLD RANGE');
 });
 it('refreshes conversation evidence in bounded batches without any bot or customer-send request',async()=>{
  const fetch=vi.fn(async(url:string)=>response(url.includes('/refresh-evidence')?{processed:['synthetic'],failed:[],pending:0}:data));vi.stubGlobal('fetch',fetch);
  await act(async()=>{view=create(createElement(ConversionPerformance,{query:'range=30',compact:true}));});await act(async()=>view!.root.findAllByType('button').find(b=>b.props.children==='Verify latest conversations')!.props.onClick());
  expect(fetch.mock.calls.some(c=>c[0].includes('/refresh-evidence'))).toBe(true);expect(fetch.mock.calls.some(c=>/\/bot|\/send/.test(c[0]))).toBe(false);expect(JSON.stringify(view!.toJSON())).toContain('1 conversations verified');
 });
});
