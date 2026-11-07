const dayMs=86_400_000;
export const DAILY_INSIGHT_FIELDS = 'ad_id,account_id,account_currency,date_start,date_stop,spend,impressions,clicks,reach,frequency,inline_link_clicks,actions,video_play_actions,video_thruplay_watched_actions,video_p100_watched_actions';
export function actionAmount(values: unknown, kind: string): number | null {
 if(values==null)return null;
 if(!Array.isArray(values))throw Error('Facebook returned invalid action metrics');
 const found=values.filter(row=>row?.action_type===kind);
 if(found.length>1)throw Error('Facebook returned ambiguous action breakdowns');
 if(!found.length)return 0;
 const value=String(found[0].value);
 if(!/^\d+(?:\.\d{1,6})?$/.test(value)||!Number.isFinite(Number(value))||Number(value)>Number.MAX_SAFE_INTEGER)throw Error('Facebook returned invalid action counts');
 return Number(value);
}
export function dailyDeliveryMetrics(row:any){
 const count=(value:any)=>value==null?null:/^\d+$/.test(String(value))&&Number.isSafeInteger(Number(value))?Number(value):null;
 return{reach:count(row.reach),frequency:row.frequency != null && Number.isFinite(Number(row.frequency)) && Number(row.frequency)>=0 ? Number(row.frequency) : null,link_clicks:count(row.inline_link_clicks),messaging_started:actionAmount(row.actions,'onsite_conversion.messaging_conversation_started_7d'),
  video_plays:actionAmount(row.video_play_actions,'video_view'),video_thruplays:actionAmount(row.video_thruplay_watched_actions,'video_view'),video_complete:actionAmount(row.video_p100_watched_actions,'video_view'),
  action_report_time:'conversion',attribution_setting:'adset_unified'};
}
export function alignedWithPht(day:string,zone:string){
 try{
  const format=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const start=Date.parse(day+'T00:00:00+08:00');
  return [start,start+dayMs].every(ms=>{
   const p=Object.fromEntries(format.formatToParts(new Date(ms)).map(p=>[p.type,p.value])),expected=new Date(ms+8*3_600_000).toISOString().slice(0,10);
   return `${p.year}-${p.month}-${p.day}`===expected&&p.hour==='00'&&p.minute==='00'&&p.second==='00';
  });
 }catch{return false;}
}
export function normalizeDailySpend(row:any,account:{id:string;currency:string;timezone_name:string},allowed:Map<string,string>,from:string,to:string){
 const page=allowed.get(row.ad_id);if(!page)return null;
 if(String(row.account_id)!==account.id.replace(/^act_/,''))throw Error('Facebook returned a different ad account');
 if(typeof row.date_start!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(row.date_start)||row.date_start!==row.date_stop||row.date_start<from||row.date_start>to||new Date(row.date_start+'T00:00:00Z').toISOString().slice(0,10)!==row.date_start)throw Error('Facebook returned an invalid daily reporting period');
 if(row.account_currency!==account.currency)throw Error('Facebook returned inconsistent spend currencies');
 if(!/^[0-9]+(?:\.[0-9]+)?$/.test(String(row.spend)))throw Error('Facebook returned invalid spend');
 const amount=Number(row.spend);if(!Number.isFinite(amount)||amount<0)throw Error('Facebook returned invalid spend');
 const count=(v:any)=>v==null?null:/^[0-9]+$/.test(String(v))&&Number.isSafeInteger(Number(v))?Number(v):null;
 return{page_id:page,ad_id:row.ad_id,account_id:account.id.replace(/^act_/,''),spend_date:row.date_start,currency:account.currency,account_timezone:account.timezone_name,pht_aligned:alignedWithPht(row.date_start,account.timezone_name),amount,impressions:count(row.impressions),clicks:count(row.clicks),checked_at:new Date().toISOString()};
}
