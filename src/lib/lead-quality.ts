export type LeadQualityStatus='poor'|'good'|'unassessed';
/** Current staff/system assessment, separate from documented payment and forecasts. */
export function leadQualityForStage(stage:unknown){
 const status:LeadQualityStatus=stage==='not_qualified'?'poor':['qualified','order_created','converted'].includes(String(stage))?'good':'unassessed';
 return{status,label:status==='poor'?'Poor lead quality':status==='good'?'Good lead quality':'Lead quality not assessed',basis:'current_pipeline_stage' as const,
  reason:status==='poor'?'Current lead stage is Not Qualified':status==='good'?'Current lead stage is Qualified, Order Created or Converted':'No positive or negative qualification is recorded'};
}
export function qualityCounts(good:number,poor:number,total:number){
 return{good,poor,unassessed:Math.max(0,total-good-poor),poor_rate:total?poor/total:null,basis:'current_pipeline_stage' as const};
}
export function qualityForAdRow(row:{inquiries:number;not_qualified?:number;qualified?:number;order_created?:number;crm_converted?:number}){
 return qualityCounts(Number(row.qualified||0)+Number(row.order_created||0)+Number(row.crm_converted||0),Number(row.not_qualified||0),Number(row.inquiries));
}
