import{describe,it,expect}from'vitest';
import{leadProbabilities,performanceAccumulator,joinDailySpend,type LeadInput}from'../conversion-performance';
import cases from'./contact-forecast-v2-golden.json';
const HOUR=3_600_000,first=Date.parse('2026-10-20T00:00:00Z'),now=first+24*HOUR;
const lead=(patch:Partial<LeadInput>={}):LeadInput=>({id:'one',page_id:'p',ad_id:'123',first_inquiry_at:new Date(first).toISOString(),inquiry_basis:'live_message',pipeline_stage:'new',cache_first_at:new Date(first).toISOString(),source_cutoff_at:new Date(now).toISOString(),payment_at:null,payment_evidence_id:null,complete_history:true,dirty_at:null,source_kind:'live_graph',snapshot:{h:24,i:'Unknown / insufficient business detail',s:'Unknown',b:'initial_inquiry',inbound:1,quoted:false,form:false,duration:false,returned:false,price_question:true,last_inbound_h:0},last_interaction_at:new Date(first).toISOString(),...patch});
const pages=[{id:'p',fb_page_id:'656646850875530'}];
describe('original-inquiry cohort performance',()=>{
 it('matches all 210 frozen independent Python forecast references without computing individual dates',()=>{
  const pageIds:Record<string,string>={'Azshinari':'656646850875530','SAMA KANA MEDIA':'717828411409985','Vista Media Agency':'725843003947429','Manawari Studios':'619355471260631','Loki Media':'781078668411527'};
  for(const sample of cases){const at=sample.first+sample.snapshot.h*HOUR,r=lead({first_inquiry_at:new Date(sample.first).toISOString(),cache_first_at:new Date(sample.first).toISOString(),source_cutoff_at:new Date(at).toISOString(),snapshot:sample.snapshot,last_interaction_at:new Date(sample.first).toISOString()});const p=leadProbabilities(r,pageIds[sample.page],at);for(const h of ['168','336','720'])expect(p.probabilities[h]).toBeCloseTo((sample.probabilities as any)[h],12);}
 });
 it('keeps a later buyer with their original ad and inquiry day; payment day does not acquire a new lead',()=>{
  const acc=performanceAccumulator(pages,.5);acc.add(lead(),now);acc.add(lead({id:'two',payment_at:new Date(first+22*HOUR).toISOString(),payment_evidence_id:'receipt'}),now);const r=acc.result();expect(r.unique_contacts).toBe(2);expect(r.daily).toHaveLength(1);expect(r.daily[0].day).toBe('2026-10-20');expect(r.ads[0].confirmed).toBe(1);expect(r.ads[0].current_rate).toBe(.5);expect(r.ads[0].avg_hours).toBe(22);expect(r.ads[0].target.actual_hit_at).toBe(new Date(first+22*HOUR).toISOString());
 });
 it('does not count a CRM converted label, future payment or unverified timestamp as a confirmed payer',()=>{
  const acc=performanceAccumulator(pages);acc.add(lead({pipeline_stage:'converted'}),now);acc.add(lead({id:'future',payment_at:new Date(now+HOUR).toISOString(),payment_evidence_id:'future'}),now);acc.add(lead({id:'bad',payment_at:new Date(first+HOUR).toISOString(),payment_evidence_id:null}),now);expect(acc.result().pages[0].confirmed).toBe(0);expect(acc.result().pages[0].crm_converted).toBe(1);
 });
 it('keeps missing and stale sources unknown and withholds a whole-cohort point forecast',()=>{
  const acc=performanceAccumulator(pages);acc.add(lead({complete_history:false}),now);acc.add(lead({id:'stale',source_cutoff_at:new Date(now-HOUR).toISOString()}),now);const r=acc.result().pages[0];expect(r.forecast['720'].rate).toBeNull();expect(r.forecast['720'].unknown).toBe(2);expect(r.forecast['720'].upper_bound).toBe(1);expect(r.target.status).toBe('insufficient_source');
 });
 it('treats an observed completed horizon as known even when the source is old; it never means never buying',()=>{
  const r=leadProbabilities(lead({source_cutoff_at:new Date(first+721*HOUR).toISOString(),snapshot:null}),'656646850875530',first+1000*HOUR);expect(r.probabilities['720']).toBe(0);
 });
 it('keeps qualification separate from confirmed payments and rejects duplicate input pages',()=>{
  const acc=performanceAccumulator(pages);acc.add(lead({pipeline_stage:'not_qualified'}),now);expect(acc.result().ads[0].not_qualified).toBe(1);expect(()=>acc.add(lead(),now)).toThrow('Duplicate');expect(()=>acc.add(lead({id:'other',page_id:'forbidden'}),now)).toThrow('authorized');
 });
 it('uses ceil(N*target) and a probability-weighted projection rather than rounding expected buyers to successes',()=>{
  const acc=performanceAccumulator(pages,.04);for(let i=0;i<26;i++)acc.add(lead({id:'c'+i}),now);const r=acc.result().ads[0];expect(r.target.required_payers).toBe(2);expect(r.forecast['720'].expected).toBeGreaterThan(0);expect(r.forecast['720'].expected).toBeLessThan(1);expect(r.confirmed).toBe(0);
 });
});
describe('daily advertising spend coverage',()=>{
 const range={from:'2026-10-19T16:00:00Z',to:'2026-10-21T16:00:00Z'},row={page_id:'p',ad_id:'123',day:null,leads:10,confirmed:2};
 const spend=(date:string,amount:number)=>({page_id:'p',ad_id:'123',spend_date:date,amount,currency:'PHP',pht_aligned:true,checked_at:'2026-10-22T00:00:00Z'});
 it('divides spend by only the original linked leads and buyers, with complete date coverage',()=>{const r=joinDailySpend([row],[spend('2026-10-20',100),spend('2026-10-21',200)],range)[0];expect(r.spend.amount).toBe(300);expect(r.cost_per_linked_inquiry).toBe(30);expect(r.cost_per_confirmed_payer).toBe(150);});
 it('never turns a missing day, different timezone, unknown ad or mixed currency into zero spend',()=>{
  expect(joinDailySpend([row],[spend('2026-10-20',100)],range)[0].spend.amount).toBeNull();
  expect(joinDailySpend([{...row,day:'2026-10-20'}],[{...spend('2026-10-20',100),pht_aligned:false}],range)[0].spend.amount).toBeNull();
  expect(joinDailySpend([{...row,ad_id:null}],[spend('2026-10-20',100)],range)[0].spend.amount).toBeNull();
  expect(joinDailySpend([row],[spend('2026-10-20',100),{...spend('2026-10-21',200),currency:'USD'}],range)[0].spend.amount).toBeNull();
 });
 it('preserves an explicit reported zero and handles zero-lead ads without division by zero',()=>{const r=joinDailySpend([{...row,day:'2026-10-20',leads:0,confirmed:0}],[spend('2026-10-20',0)],range)[0];expect(r.spend.amount).toBe(0);expect(r.cost_per_linked_inquiry).toBeNull();expect(r.cost_per_confirmed_payer).toBeNull();});
});
