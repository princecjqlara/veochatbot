'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
type Bot={enabled:boolean;can_reply:boolean;reason:string;loaded_at?:string};
const labels:Record<string,string>={allowed:'Allowed for the next customer message',contact_disabled:'Contact switch is off',page_disabled:'Page bot is off',outside_page_trial:'Outside the Page’s trial contact',closed_stage:'Recorded closed stage',human_handoff:'A person controls this conversation',awaiting_new_message:'Waiting for a new customer message'};
const p=(v:number|null|undefined)=>v==null?'N/A':(100*v).toFixed(2)+'%';
const when=(s:string)=>new Intl.DateTimeFormat('en-PH',{timeZone:'Asia/Manila',dateStyle:'medium',timeStyle:'short'}).format(new Date(s));
// Bounded visible-contact refreshes, rather than a burst of history reads.
const queue:Array<()=>void>=[];let active=0;
function queued<T>(operation:()=>Promise<T>):Promise<T>{return new Promise((yes,no)=>{const run=()=>{active++;operation().then(yes,no).finally(()=>{active--;queue.shift()?.();});};if(active<2)run();else queue.push(run);});}

export default function ContactBotProjection({pageId,contactId,name,enabled=true,initialBot,initialProjection,onChanged}:{pageId:string;contactId:string;name:string;enabled?:boolean;initialBot?:Bot;initialProjection?:any;onChanged?:()=>void}){
 const [bot,setBot]=useState<Bot|undefined>(initialBot),[projection,setProjection]=useState<any>(initialProjection),[saving,setSaving]=useState(false),[refreshing,setRefreshing]=useState(false),[error,setError]=useState(''),[expanded,setExpanded]=useState(false);
 const busy=useRef(false),changed=useRef(0),mounted=useRef(true),autoDone=useRef('');
 const base=`/api/pages/${encodeURIComponent(pageId)}/contacts/${encodeURIComponent(contactId)}`;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{if(initialBot&&!busy.current&&Date.parse(initialBot.loaded_at||'')>=changed.current)setBot(initialBot);},[initialBot]);
 useEffect(()=>{if(initialProjection)setProjection((old:any)=>!old||!old.as_of||Date.parse(initialProjection.as_of||'')>=Date.parse(old.as_of||'')?initialProjection:old);},[initialProjection]);
 const load=useCallback(async()=>{try{const r=await fetch(base+'/projection',{cache:'no-store'}),d=await r.json();if(!r.ok)throw Error(d.error);if(mounted.current&&!busy.current){setBot(d.bot_control);setProjection(d.conversion_projection);}}catch(e){if(mounted.current)setError((e as Error).message);}},[base]);
 useEffect(()=>{if(!initialBot)void load();},[initialBot,load]);
 const refresh=useCallback(async()=>{
  if(busy.current)return;setRefreshing(true);setError('');
  try{const data:any=await queued(async()=>{if(!mounted.current)return null;const r=await fetch(base+'/projection',{method:'POST'}),d=await r.json();if(!r.ok)throw Error(d.error||'Projection refresh failed');return d;});if(data&&mounted.current)setProjection(data.conversion_projection);}
  catch(e){if(mounted.current)setError((e as Error).message);}
  finally{if(mounted.current)setRefreshing(false);}
 },[base]);
 useEffect(()=>{if(projection?.needs_refresh&&!refreshing){const stamp=projection.as_of||'missing';if(autoDone.current!==stamp){autoDone.current=stamp;void refresh();}}},[projection,refreshing,refresh]);
 const toggle=async()=>{
  busy.current=true;changed.current=Date.now();setSaving(true);setError('');
  try{const r=await fetch(base+'/bot',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:!(bot?.enabled??enabled)})}),d=await r.json();if(!r.ok)throw Error(d.error||'Could not save bot permission');setBot(old=>({...old,enabled:d.enabled,can_reply:false,reason:d.enabled?'awaiting_new_message':'contact_disabled'}));busy.current=false;await load();onChanged?.();}
  catch(e){setError((e as Error).message);}
  finally{busy.current=false;setSaving(false);}
 };
 const isOn=bot?.enabled??enabled,score=projection?.scores?.['720'],closed=projection?.status==='window_ended',paid=projection?.status==='documented_confirmation',needsProof=projection?.status==='payment_verification_needed';
 const timing=projection?.close_window||projection?.close_windows?.['336']||projection?.close_windows?.['168'],timingHorizon=timing?.horizon_days||30;
 return <div className="min-w-[230px] max-w-sm text-xs space-y-2 normal-case">
  <div className="flex flex-wrap items-center gap-2"><button type="button" role="switch" aria-checked={isOn} aria-label={`Bot permission for ${name}`} disabled={saving||!bot} onClick={toggle} className={`px-2 py-1 border border-black font-semibold disabled:opacity-50 ${isOn?'bg-green-50 text-green-900':'bg-gray-100 text-gray-700'}`}>{saving?'Saving…':`Bot permission ${isOn?'ON':'OFF'}`}</button><span className="text-gray-600">{bot?(labels[bot.reason]||bot.reason.replaceAll('_',' ')):'Loading permission…'}</span></div>
  <div><b>Payment projection:</b> {paid?'Documented confirmation':needsProof?'Payment evidence needs verification':closed?'30-day window ended':score?.probability!=null?`${p(score.probability)} by Day 30`:'Not available yet'} {refreshing&&<span className="text-gray-500"> · updating…</span>}</div>
  {!paid&&!closed&&!needsProof&&projection?.status==='estimated'&&<p className="text-gray-600">Available before agreeing to a commercial. {projection?.signal_stage?.label||'Based on the recorded conversation'}.</p>}
  {!paid&&!closed&&!needsProof&&projection?.scores&&<p>By Day 7: {p(projection.scores['168']?.probability)} · Day 14: {p(projection.scores['336']?.probability)}</p>}
  {!paid&&!closed&&!needsProof&&timing&&<p>If confirmed by Day {timingHorizon}: about {timing.median_remaining_days.toFixed(1)} days from the source check. Median estimated date: {timing.median_date_pht} PHT{timing.middle80_remaining_days&&<>. Estimated range: {timing.middle80_remaining_days.map((v:number)=>v.toFixed(1)).join(' to ')} days</>}.</p>}
  {!paid&&!closed&&!needsProof&&projection?.timing_unavailable_reason&&<p className="text-gray-600">{projection.timing_unavailable_reason}</p>}
  {!paid&&!closed&&!needsProof&&projection?.forecast_method==='conversation_survival_v2'&&projection?.checkpoint_hours===0&&<p className="text-amber-800">Early estimate: individual buying signals are still limited.</p>}
  {projection?.needs_refresh&&projection?.as_of&&<p className="text-amber-800">Older source: {when(projection.as_of)} PHT. Refresh for a current estimate.</p>}
  <div className="flex gap-3"><button type="button" className="underline" onClick={()=>setExpanded(!expanded)}>{expanded?'Hide projection':'Projection details'}</button><button type="button" className="underline disabled:opacity-50" disabled={refreshing} onClick={()=>void refresh()}>Update projection</button></div>
  {error&&<p role="alert" className="text-red-800 break-words">{error}</p>}
  {expanded&&<div className="border border-gray-300 p-2 space-y-1 text-gray-700">
   {projection?.message&&<p>{projection.message}</p>}
   <p>Bot ON permits automated replies and follow-ups. Page settings, trials, handoffs, opt-outs and closed stages still apply. Switching ON sends no message and does not restore cancelled jobs.</p>
   {projection?.scores&&<p>By Day 7: {p(projection.scores['168']?.probability)} · Day 14: {p(projection.scores['336']?.probability)} · Day 30: {p(projection.scores['720']?.probability)}</p>}
   {projection?.scores&&<p>These windows run from the first inquiry. Remaining days are conditional on confirmation within the selected window, not a promise to buy.</p>}
   {!paid&&!closed&&!needsProof&&projection?.forecast_method==='conversation_survival_v2'&&['168','336'].map(h=>projection?.close_windows?.[h]&&<p key={h}>If confirmed by Day {Number(h)/24}: about {projection.close_windows[h].median_remaining_days.toFixed(1)} days from the source check; estimated range {projection.close_windows[h].middle80_remaining_days.map((v:number)=>v.toFixed(1)).join(' to ')} days.</p>)}
   {projection?.first_inquiry_at&&<p>First inquiry: {when(projection.first_inquiry_at)} PHT</p>}
   {projection?.as_of&&<p>Source checked: {when(projection.as_of)} PHT{projection.stale?' · older source':''}</p>}
   {projection?.checkpoint_at&&<p>Conversation features through: {when(projection.checkpoint_at)} PHT</p>}
   {projection?.status==='estimated'&&<p>An agreement, chosen package or completed form is not required. A quote or form is a conversation signal; it does not prove the customer agreed or paid. Source refreshes check payment evidence and use the latest completed checkpoint at 0, 1, 6, 24, 72, 168 or 336 hours.</p>}
   {projection?.close_window&&<p>Middle-half conditional dates: {projection.close_window.middle50_dates_pht.join(' to ')} PHT. This describes customers who confirm within 30 days, not a promised purchase.</p>}
   {!paid&&!closed&&!needsProof&&projection?.backtest?.n>0&&<p>Across the five Pages at this checkpoint, the 30-day replay averaged {p(projection.backtest.mean_predicted)} predicted versus {p(projection.backtest.actual_rate)} observed confirmations among {projection.backtest.n.toLocaleString()} still-unpaid contacts. Percentage calibration remains imperfect.</p>}
   {!paid&&!closed&&!needsProof&&projection?.signal_stage&&<div className="border-t border-gray-200 pt-1"><b>Replay for {projection.signal_stage.label.toLowerCase()}:</b>{['168','336','720'].map(h=>{const m=projection.stage_backtests?.[h];return m&&<p key={h}>By Day {Number(h)/24}: {m.n.toLocaleString()} contacts, {m.events} later confirmations; {p(m.mean_predicted)} predicted versus {p(m.actual_rate)} observed. Ranking AUC: {m.auc==null?'N/A':m.auc.toFixed(3)}.{m.events<30?' Too few later confirmations for an individual date in this group.':''}</p>;})}<p>AUC of 0.5 is chance ranking; it is not percent correct. These groups describe messages recorded at that time. Agreement was not independently labeled in the historical data.</p></div>}
   {projection?.backtest?.timing?.n>0&&<p>Historical replay at this checkpoint: {projection.backtest.timing.n} later confirmations; average timing error {projection.backtest.timing.mae_days.toFixed(2)} days; {(100*projection.backtest.timing.within_3_days).toFixed(1)}% within 3 days. The estimated range contained {(100*projection.backtest.timing.central80_coverage).toFixed(1)}% of actual confirmation times. These are overall replay results, not a guarantee for this contact.</p>}
   {projection?.support&&<p>{projection.support.comparable_records} comparable training records at this checkpoint. {projection.industry} · {projection.behavior?.replaceAll('_',' ')}</p>}
   <p>Experimental payment/deposit confirmation forecast, not a bank-settlement check. {projection?.forecast_method==='conversation_survival_v2'?'The formula was tested on later weekly cohorts. Estimates remain uncertain; refreshing a conversation does not retrain the model.':'The prior Day-30 timing error averaged 6.48 days in the supported backtest.'} A closed window does not mean never buying.</p>
   {projection?.model_version&&<p>Model {projection.model_version}</p>}
  </div>}
 </div>;
}
