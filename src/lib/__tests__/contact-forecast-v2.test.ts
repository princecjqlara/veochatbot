import{describe,it,expect}from'vitest';
import{scoreContactForecast,type ForecastCache}from'../contact-forecast';
import{boostedRates,type BoostModel}from'../contact-forecast-boost';
import cases from'./contact-forecast-v2-golden.json';
const model=require('../conversion-runtime/model-v2.json') as BoostModel;
function cache(s:typeof cases[number]):ForecastCache{return{contact_id:'synthetic',page_id:'synthetic-page',first_inquiry_at:new Date(s.first).toISOString(),source_cutoff_at:new Date(s.first+s.snapshot.h*3_600_000).toISOString(),snapshots:[s.snapshot],payment_at:null,payment_evidence_id:null,source_kind:'synthetic',complete_history:true,dirty_at:null};}
describe('validated second-generation forecast',()=>{
 it('matches the independent Python reference across 210 synthetic Page, industry, behavior and timing cases',()=>{
  for(const sample of cases){const rs=boostedRates(model,sample.page,sample.first,sample.snapshot);rs.forEach((r,j)=>expect(r).toBeCloseTo(sample.rates[j],12));const c=cache(sample),r:any=scoreContactForecast(c,sample.page,Date.parse(c.source_cutoff_at));expect(r.model_version).toBe(model.version);expect(r.forecast_method).toBe('conversation_survival_v2');
   for(const h of ['168','336','720'])expect(r.scores[h].probability).toBeCloseTo((sample.probabilities as any)[h],12);
   if(r.close_window){expect(r.close_window.median_remaining_days).toBeCloseTo(sample.days![2],7);expect(r.close_window.middle80_remaining_days[0]).toBeCloseTo(sample.days![0],7);expect(r.close_window.middle80_remaining_days[1]).toBeCloseTo(sample.days![4],7);}
  }
 });
 it('keeps probabilities monotone and ranges bounded by the remaining horizon',()=>{
  for(const sample of cases){const c=cache(sample),r:any=scoreContactForecast(c,sample.page,Date.parse(c.source_cutoff_at));expect(r.scores['168'].probability).toBeLessThanOrEqual(r.scores['336'].probability);expect(r.scores['336'].probability).toBeLessThanOrEqual(r.scores['720'].probability);
   for(const[h,w]of Object.entries(r.close_windows)as[string,any][]){expect(w.middle80_remaining_days[0]).toBeGreaterThanOrEqual(0);expect(w.middle80_remaining_days[1]).toBeLessThanOrEqual((Number(h)-sample.snapshot.h)/24+1e-9);expect(w.middle80_remaining_days[0]).toBeLessThanOrEqual(w.median_remaining_days);expect(w.middle80_remaining_days[1]).toBeGreaterThanOrEqual(w.median_remaining_days);expect(w.timing_validation_n).toBeGreaterThanOrEqual(30);}
  }
 });
 it('withholds individual dates at checkpoints with too few later confirmations',()=>{
  const sample=cases.find(s=>s.snapshot.h===336)!,c=cache(sample),r:any=scoreContactForecast(c,sample.page,Date.parse(c.source_cutoff_at));expect(r.close_window).toBeNull();expect(r.timing_unavailable_reason).toContain('Too few');
 });
 it('preserves the prior validated model when richer conversation signals are absent',()=>{
  const sample=cases[0],c=cache(sample);c.snapshots=c.snapshots.map(({h,i,s,b})=>({h,i,s,b}));const r:any=scoreContactForecast(c,sample.page);expect(r.model_version).toBe('eddb1b3d6b59c75e');expect(r.forecast_method).toBe('legacy_survival_v1');
 });
 it('conditions on still being unpaid at the source cutoff, never on future outcome fields',()=>{
  const sample=cases.find(s=>s.snapshot.h===24)!,c=cache(sample),r:any=scoreContactForecast(c,sample.page);const future:any=scoreContactForecast({...c,payment_at:new Date(Date.parse(c.source_cutoff_at)+3_600_000).toISOString(),payment_evidence_id:'not-yet-observed'},sample.page);expect(future.scores).toEqual(r.scores);
  const paid:any=scoreContactForecast({...c,payment_at:c.source_cutoff_at,payment_evidence_id:'documentary-proof'},sample.page);expect(paid.status).toBe('documented_confirmation');expect(paid.scores['720'].future_probability).toBe(0);expect(paid.close_window).toBeNull();
 });
});
