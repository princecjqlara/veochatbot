import{boostedRates,hasConversationFeatures,type BoostModel}from'./contact-forecast-boost';
import{forecastPageName,type ForecastSnapshot}from'./contact-forecast';
const model=require('./conversion-runtime/model-v2.json') as BoostModel;
const HOUR=3_600_000,DAY=24*HOUR;
export type LeadInput={id:string;page_id:string;ad_id:string|null;first_inquiry_at:string;inquiry_basis:string;pipeline_stage:string;cache_first_at:string|null;source_cutoff_at:string|null;payment_at:string|null;payment_evidence_id:string|null;complete_history:boolean|null;dirty_at:string|null;source_kind:string|null;snapshot:ForecastSnapshot|null;last_interaction_at:string|null};
type Row={page_id:string;ad_id:string|null;day:string|null;leads:number;confirmed:number;qualified:number;not_qualified:number;crm_converted:number;durations:number[];first_min:number|null;first_max:number|null;legacy_dates:number;unverified:number;newer_activity:number;forecast:Record<string,{known:number;expected:number;covered:number;unknown:number}>;source_min:string|null;source_max:string|null};
export function phtDate(ms:number){return new Date(ms+8*HOUR).toISOString().slice(0,10);}
function integrate(rates:number[],start:number,end:number){return rates.reduce((sum,r,j)=>sum+r*Math.max(0,Math.min(model.edges_hours[j+1],end)-Math.max(model.edges_hours[j],start)),0);}
export function leadProbabilities(r:LeadInput,facebookId:string,now:number){
 const first=Date.parse(r.first_inquiry_at),source=Date.parse(r.source_cutoff_at||''),payment=Date.parse(r.payment_at||'');
 const valid=!!r.complete_history&&Number.isFinite(source)&&Date.parse(r.cache_first_at||'')===first;
 const paid=valid&&!!r.payment_evidence_id&&Number.isFinite(payment)&&payment>=first&&payment<=Math.min(source,now);
 const activity=Math.max(Date.parse(r.last_interaction_at||'')||0,Date.parse(r.dirty_at||'')||0);
 const fresh=valid&&source>=now-15*60_000&&activity<=source;
 const page=forecastPageName(facebookId),age=(now-first)/HOUR,observed=(source-first)/HOUR;
 const f=r.snapshot,rich=!!f&&hasConversationFeatures(f)&&f.h<=Math.min(age,observed),rates=fresh&&rich&&page?boostedRates(model,page,first,f!):null;
 const probabilities:Record<string,number|null>={};
 for(const h of [168,336,720]){
  if(paid){probabilities[String(h)]=Number(payment-first<=h*HOUR);continue;}
  if(valid&&observed>=h){probabilities[String(h)]=0;continue;}
  probabilities[String(h)]=fresh&&rates&&age<h?-Math.expm1(-Math.min(700,integrate(rates,age,h))):null;
 }
 return{paid,payment:paid?payment:null,valid,fresh,changed:activity>source,probabilities};
}
function empty(page_id:string,ad_id:string|null,day:string|null):Row{return{page_id,ad_id,day,leads:0,confirmed:0,qualified:0,not_qualified:0,crm_converted:0,durations:[],first_min:null,first_max:null,legacy_dates:0,unverified:0,newer_activity:0,forecast:Object.fromEntries(['168','336','720'].map(h=>[h,{known:0,expected:0,covered:0,unknown:0}])),source_min:null,source_max:null};}
export function performanceAccumulator(pages:Array<{id:string;fb_page_id:string}>){
 const byPage=new Map(pages.map(p=>[p.id,empty(p.id,null,null)])),ads=new Map<string,Row>(),daily=new Map<string,Row>(),ids=new Map(pages.map(p=>[p.id,p.fb_page_id]));
 const seen=new Set<string>();
 function add(r:LeadInput,now:number){
  if(seen.has(r.id))throw Error('Duplicate cohort contact');seen.add(r.id);
  const page=byPage.get(r.page_id);if(!page)throw Error('Contact outside authorized report');
  const day=phtDate(Date.parse(r.first_inquiry_at)),adKey=JSON.stringify([r.page_id,r.ad_id]),dayKey=JSON.stringify([r.page_id,r.ad_id,day]);
  if(!ads.has(adKey))ads.set(adKey,empty(r.page_id,r.ad_id,null));if(!daily.has(dayKey))daily.set(dayKey,empty(r.page_id,r.ad_id,day));
  const result=leadProbabilities(r,ids.get(r.page_id)!,now);
  for(const row of [page,ads.get(adKey)!,daily.get(dayKey)!]){
   row.leads++;row.qualified+=Number(r.pipeline_stage==='qualified');row.not_qualified+=Number(r.pipeline_stage==='not_qualified');row.crm_converted+=Number(r.pipeline_stage==='converted');row.legacy_dates+=Number(r.inquiry_basis==='legacy_recorded');row.unverified+=Number(!result.valid);row.newer_activity+=Number(result.changed);
   const first=Date.parse(r.first_inquiry_at);row.first_min=row.first_min==null?first:Math.min(row.first_min,first);row.first_max=row.first_max==null?first:Math.max(row.first_max,first);
   if(result.paid){row.confirmed++;row.durations.push((result.payment!-first)/HOUR);}
   if(r.source_cutoff_at){row.source_min=!row.source_min||r.source_cutoff_at<row.source_min?r.source_cutoff_at:row.source_min;row.source_max=!row.source_max||r.source_cutoff_at>row.source_max?r.source_cutoff_at:row.source_max;}
   for(const h of ['168','336','720']){const p=result.probabilities[h],g=row.forecast[h];if(p==null)g.unknown++;else{g.covered++;g.expected+=p;g.known+=Number(result.paid&&p===1);}}
  }
 }
 function finish(row:Row){
  const durations=[...row.durations].sort((a,b)=>a-b),len=durations.length;
  const forecast=Object.fromEntries(Object.entries(row.forecast).map(([h,g])=>[h,{...g,rate:row.leads&&!g.unknown?g.expected/row.leads:null,lower_bound:row.leads?g.expected/row.leads:null,upper_bound:row.leads?(g.expected+g.unknown)/row.leads:null}]));
  const final=forecast['720'],available=final.rate!=null,additional=available?Math.max(0,final.expected-final.known):null;
  const total=additional==null?null:row.confirmed+additional;
  const {durations:_,first_min,first_max,...plain}=row;
  return{...plain,current_rate:row.leads?row.confirmed/row.leads:null,avg_hours:len?durations.reduce((a,b)=>a+b,0)/len:null,median_hours:len?(durations[Math.floor((len-1)/2)]+durations[Math.floor(len/2)])/2:null,forecast,
   outlook:{status:!row.leads?'no_leads':!available?'insufficient_source':(additional??0)>0?'estimated':'observed_window',horizon_days:30,expected_rate:total!=null&&row.leads?total/row.leads:null,expected_payers:total,expected_additional_payers:additional,recorded_payers:row.confirmed,confirmed_within_horizon:final.known,unknown_sources:final.unknown,
    horizon_end_dates_pht:first_min!=null&&first_max!=null?[phtDate(first_min+30*DAY),phtDate(first_max+30*DAY)]:null}};
 }
 return{add,result:()=>({pages:[...byPage.values()].map(finish),ads:[...ads.values()].map(finish),daily:[...daily.values()].map(finish),unique_contacts:seen.size})};
}

export function joinDailySpend(rows:any[],spend:any[],range:{from:string|null;to:string}){
 const last=phtDate(Date.parse(range.to)-1),first=range.from?phtDate(Date.parse(range.from)):null;
 return rows.map(row=>{
  const matching=spend.filter(s=>s.page_id===row.page_id&&s.ad_id===row.ad_id&&(!row.day||s.spend_date===row.day));
  const aligned=matching.filter(s=>s.pht_aligned),currencies=[...new Set(aligned.map(s=>s.currency))];
  const days=new Set(aligned.map(s=>s.spend_date)),required=row.day?1:first?Math.round((Date.parse(last)-Date.parse(first))/DAY)+1:null;
  const complete=required!=null&&days.size===required&&currencies.length===1;
  const amount=aligned.reduce((sum,s)=>sum+Number(s.amount),0);
  return{...row,spend:{amount:complete?amount:null,recorded_amount:aligned.length&&currencies.length===1?amount:null,currency:currencies.length===1?currencies[0]:null,covered_days:days.size,required_days:required,timezone_mismatch:matching.some(s=>!s.pht_aligned),checked_at:matching.map(s=>s.checked_at).sort().at(-1)||null},cost_per_linked_inquiry:complete&&row.leads?amount/row.leads:null,cost_per_confirmed_payer:complete&&row.confirmed?amount/row.confirmed:null};
 });
}
