import type {ForecastSnapshot} from './contact-forecast';

type Metric={n:number;events:number;mean_predicted:number;actual_rate:number;auc:number|null;timing:{n:number;mae_days:number|null;within_3_days:number|null;central80_coverage:number|null}};
type StageAudit={model_version:string;projection_policy_version:string;groups:Record<string,Record<string,Record<string,Metric>>>};
const audit=require('./conversion-runtime/stage-backtest.json') as StageAudit;
const early=new Set(['initial_inquiry','active_conversation','returned_later']);

// These are observed conversation signals, never a claim about private intent
// or an independently verified commercial agreement.
export function contactSignalGroup(f:ForecastSnapshot){
 return early.has(f.b)&&!f.form&&!f.duration?'inquiry_or_conversation':'quote_or_details';
}
export function contactStageValidation(version:string,f:ForecastSnapshot,horizon:number){
 const group=contactSignalGroup(f);
 return {group,label:group==='inquiry_or_conversation'?'Inquiry / conversation signals':'Quote response / package details',agreement_required:false,agreement_verified:false,
  metric:version===audit.model_version?audit.groups[String(horizon)]?.[String(f.h)]?.[group]||null:null,
  policy_version:audit.projection_policy_version};
}
export function stageTimingSupported(metric:Metric|null|undefined){
 return !!metric&&metric.n>=100&&metric.timing.n>=30;
}
