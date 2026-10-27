import{describe,it,expect}from'vitest';
import{scoreContactForecast,forecastPageName,type ForecastCache}from'../contact-forecast';
import cases from'./contact-forecast-golden.json';
describe('production forecast matches the validated Python model',()=>{
 it('reproduces every probability, conditional median and interval across 48 synthetic cases',()=>{
  for(const sample of cases){const r:any=scoreContactForecast(sample.cache as ForecastCache,sample.page,Date.parse(sample.cache.source_cutoff_at));for(const h of ['168','336','720'])expect(r.scores[h].probability).toBeCloseTo((sample.expected as any)[h],12);
   if(sample.timing){expect(r.close_window.median_remaining_days).toBeCloseTo(sample.timing.median_remaining_days,10);expect(r.close_window.middle50_remaining_days[0]).toBeCloseTo(sample.timing.central50_remaining_days[0],10);expect(r.close_window.middle50_dates_pht).toEqual(sample.timing.central50_estimated_dates);}else expect(r.close_window).toBeNull();
  }
 });
 it('does not invent probabilities for untrained Pages or incomplete sources',()=>{
  expect((scoreContactForecast(null,'Untrained Page') as any).needs_refresh).toBe(false);
  expect(scoreContactForecast({...cases[0].cache,complete_history:false} as ForecastCache,'Azshinari').status).toBe('incomplete_history');
  expect(forecastPageName('656646850875530')).toBe('Azshinari');expect(forecastPageName('different-page')).toBe('');
 });
 it('does not double-count a verified paying contact and distinguishes a closed window from never buying',()=>{
  const c={...cases[0].cache,first_inquiry_at:'2026-10-01T00:00:00Z',source_cutoff_at:'2026-10-24T00:00:00Z',payment_at:'2026-10-02T00:00:00Z',payment_evidence_id:'source-proof'} as ForecastCache;
  const r:any=scoreContactForecast(c,'Azshinari');expect(r.status).toBe('documented_confirmation');expect(r.scores['720'].future_probability).toBe(0);expect(r.scores['720'].probability).toBe(1);
  const closed:any=scoreContactForecast(cases.at(-1)!.cache as ForecastCache,'Azshinari');expect(closed.status).toBe('window_ended');expect(closed.limitation).toContain('never buying');
 });
});
