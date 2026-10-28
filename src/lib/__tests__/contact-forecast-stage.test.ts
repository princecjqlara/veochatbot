import{describe,it,expect}from'vitest';
import{contactSignalGroup,contactStageValidation,stageTimingSupported}from'../contact-forecast-stage';
import{scoreContactForecast,type ForecastCache,type ForecastSnapshot}from'../contact-forecast';
const first='2026-10-20T00:00:00Z';
const initial:ForecastSnapshot={h:24,i:'Unknown / insufficient business detail',s:'Unknown',b:'initial_inquiry',inbound:1,quoted:false,form:false,duration:false,returned:false,price_question:true,last_inbound_h:0};
const cache=(f:ForecastSnapshot):ForecastCache=>({contact_id:'synthetic',page_id:'synthetic',first_inquiry_at:first,source_cutoff_at:new Date(Date.parse(first)+f.h*3_600_000).toISOString(),snapshots:[f],payment_at:null,payment_evidence_id:null,source_kind:'synthetic',complete_history:true,dirty_at:null});
describe('forecasts before agreement',()=>{
 it('projects 7/14/30-day payment from a single inquiry without any agreement, quote, duration or form',()=>{
  for(const h of [0,1,6,24]){const c=cache({...initial,h}),r:any=scoreContactForecast(c,'Azshinari',Date.parse(c.source_cutoff_at));expect(r.status).toBe('estimated');expect(r.signal_stage.agreement_required).toBe(false);expect(r.signal_stage.agreement_verified).toBe(false);expect(r.signal_stage.group).toBe('inquiry_or_conversation');for(const horizon of ['168','336','720'])expect(r.scores[horizon].probability).toBeGreaterThan(0);}
 });
 it('retains early probabilities but withholds dates when fewer than 30 stage-specific replay buyers exist',()=>{
  const c=cache(initial),r:any=scoreContactForecast(c,'Azshinari',Date.parse(c.source_cutoff_at));expect(r.stage_backtests['720'].n).toBe(1688);expect(r.stage_backtests['720'].events).toBe(18);expect(r.close_window).toBeNull();expect(r.close_windows).toEqual({});expect(r.timing_unavailable_reason).toContain('conversation-signal group');expect(r.scores['720'].probability).toBeGreaterThan(0);
 });
 it('does not treat receiving a quote or an unknown industry as an agreement',()=>{
  expect(contactSignalGroup({...initial,quoted:true})).toBe('inquiry_or_conversation');expect(contactSignalGroup({...initial,b:'active_conversation',inbound:4})).toBe('inquiry_or_conversation');expect(contactSignalGroup({...initial,b:'returned_later',returned:true})).toBe('inquiry_or_conversation');expect(contactSignalGroup({...initial,b:'replied_after_quote',quoted:true})).toBe('quote_or_details');
 });
 it('does not attach the wrong model or checkpoint accuracy to a contact',()=>{
  expect(contactStageValidation('future-unvalidated-model',initial,720).metric).toBeNull();expect(contactStageValidation('dd7f0ca783ad1651',{...initial,h:13},720).metric).toBeNull();expect(stageTimingSupported(null)).toBe(false);
 });
 it('uses only the completed earlier snapshot when newer buying signals are not yet observed',()=>{
  const c=cache(initial),earlier:any=scoreContactForecast(c,'Azshinari',Date.parse(c.source_cutoff_at));const r:any=scoreContactForecast({...c,snapshots:[initial,{...initial,h:72,b:'form_details',form:true,inbound:20}]},'Azshinari',Date.parse(c.source_cutoff_at));expect(r.signal_stage).toEqual(earlier.signal_stage);expect(r.scores).toEqual(earlier.scores);expect(r.stage_backtests).toEqual(earlier.stage_backtests);
 });
});
