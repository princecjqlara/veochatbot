'use client';
import{useCallback,useEffect,useRef,useState}from'react';
import AdCreativePreview from'./AdCreativePreview';
const pct=(v:number|null|undefined)=>v==null?'N/A':(v*100).toFixed(2)+'%';
const count=(v:number)=>Number(v||0).toLocaleString();
const hours=(v:number|null|undefined)=>v==null?'N/A':v<1?(v*60).toFixed(0)+' min':v<48?v.toFixed(1)+' h':(v/24).toFixed(1)+' days';
const when=(v:string)=>new Intl.DateTimeFormat('en-PH',{timeZone:'Asia/Manila',dateStyle:'medium',timeStyle:'short'}).format(new Date(v));
const day=(ms:number)=>new Date(ms+8*3_600_000).toISOString().slice(0,10);
const money=(amount:number|null,currency:string|null)=>amount==null||!currency?'N/A':new Intl.NumberFormat('en-PH',{style:'currency',currency}).format(amount);
function projected(r:any,h='720'){const f=r.forecast?.[h];return f?.rate!=null?pct(f.rate):`N/A${f?.unknown?` · ${count(f.unknown)} need source verification`:''}`;}
function targetText(r:any){const t=r.target;if(!r.leads)return'N/A — no leads';return t.status==='already_reached'?`Reached ${when(t.actual_hit_at)} PHT`:t.status==='expected_by_horizon'?`Expected rate ≥ ${pct(t.rate)} by Day ${t.expected_horizon_days}${t.expected_by_date_pht?' · '+t.expected_by_date_pht+' PHT':' from each first inquiry'}`:t.status==='insufficient_source'?'Needs source verification':'Not projected within 30 days';}

export default function ConversionPerformance({query='range=today',compact=false,connection}:{query?:string;compact?:boolean;connection?:any}){
 const[data,setData]=useState<any>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[target,setTarget]=useState('4'),[daily,setDaily]=useState(true),[notice,setNotice]=useState(''),[refreshing,setRefreshing]=useState(false),[spending,setSpending]=useState(false),[automatic,setAutomatic]=useState(true);
 const generation=useRef(0),fetching=useRef(false),evidenceBusy=useRef(false),lastAuto=useRef(0),failedUntil=useRef(0);
 const[adFilter,setAdFilter]=useState('all'),[offset,setOffset]=useState(0);
 useEffect(()=>{setOffset(0);setAdFilter('all');setNotice('');},[query]);useEffect(()=>{setOffset(0);},[daily,adFilter]);
 const currentQuery=useRef(query);currentQuery.current=query;
 const load=useCallback(async()=>{
  const key=++generation.current;fetching.current=true;setLoading(true);
  try{const r=await fetch('/api/ad-quality/performance?'+query+'&target='+encodeURIComponent(target),{cache:'no-store'}),d=await r.json();if(!r.ok)throw Error(d.error||'Could not load conversion summary');if(key===generation.current){setData(d);setError('');}}
  catch(e){if(key===generation.current)setError((e as Error).message);}finally{if(key===generation.current){fetching.current=false;setLoading(false);}}
 },[query,target]);
 const loadRef=useRef(load);useEffect(()=>{loadRef.current=load;},[load]);
 useEffect(()=>{setData(null);void load();return()=>{generation.current++;};},[load]);
 useEffect(()=>{if(!automatic)return;const timer=setInterval(()=>{if(!document.hidden&&!fetching.current)void loadRef.current();},60_000);return()=>clearInterval(timer);},[automatic]);
 const verify=useCallback(async(manual=true)=>{
  if(evidenceBusy.current)return;evidenceBusy.current=true;setRefreshing(true);const sourceQuery=query,skip:string[]=[];let successful=0,failed=0;
  try{
   for(let batch=0;batch<(manual?40:1);batch++){
    if(currentQuery.current!==sourceQuery)break;
    const r=await fetch('/api/ad-quality/refresh-evidence?'+sourceQuery,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({skip})}),d=await r.json();if(!r.ok)throw Error(d.error||'Conversation verification failed');
    successful+=d.processed.length;failed+=d.failed.length;skip.push(...d.processed,...d.failed);
    if(currentQuery.current===sourceQuery)setNotice(`${successful} conversations verified${failed?`; ${failed} unavailable`:''}. ${d.pending} remain in this period.`);
    if(!d.pending||!d.processed.length&&!d.failed.length||skip.length>=400)break;
   }
   if(failed)failedUntil.current=Date.now()+300_000;
  }catch(e){failedUntil.current=Date.now()+300_000;if(currentQuery.current===sourceQuery)setNotice((e as Error).message);}
  finally{evidenceBusy.current=false;setRefreshing(false);if(currentQuery.current===sourceQuery)void loadRef.current();}
 },[query]);
 useEffect(()=>{
  // Today's queue is small and contains new activity from older cohorts too.
  // Historical ranges use the explicit bounded verification action.
  if(automatic&&new URLSearchParams(query).get('range')==='today'&&data?.refresh_pending>0&&Date.now()-lastAuto.current>60_000&&Date.now()>failedUntil.current){lastAuto.current=Date.now();void verify(false);}
 },[data,query,automatic,verify]);
 const syncSpend=async()=>{
  if(spending||!connection?.accounts?.length)return;setSpending(true);const sourceQuery=query,q=new URLSearchParams(query),now=Date.now(),from=data?.range?.from?day(Date.parse(data.range.from)):day(now-29*86_400_000),to=day(Date.parse(data?.range?.to||new Date().toISOString())-1);let saved=0,calls=0;
  try{
   accountLoop:for(const account of connection.accounts){
    for(let start=Date.parse(from+'T00:00:00Z');start<=Date.parse(to+'T00:00:00Z');start+=31*86_400_000){
     const a=new Date(start).toISOString().slice(0,10),b=new Date(Math.min(start+30*86_400_000,Date.parse(to+'T00:00:00Z'))).toISOString().slice(0,10);let after:string|undefined;
     do{
      if(currentQuery.current!==sourceQuery)return;
      if(calls++>=100)throw Error('This import reached its batch limit. Saved days remain available; choose a shorter date range to continue.');
      const r=await fetch('/api/ad-quality/spend',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId:account.id,from:a,to:b,...(q.get('pageId')?{pageId:q.get('pageId')}:{}),...(after?{after}:{})})}),d=await r.json();if(!r.ok&&d.errorCode==='NO_VERIFIED_PAGE_ADS')continue accountLoop;if(!r.ok)throw Error(d.error||'Daily spend could not be read');saved+=d.saved;
      if(currentQuery.current!==sourceQuery)return;
      setNotice(`${saved} actual ad-day spend records updated. Account timezone: ${d.timezone}.`);
      if(d.paginationUnavailable)throw Error('Facebook omitted a continuation cursor; this spend import is incomplete.');after=d.complete?undefined:d.nextAfter;
     }while(after);
    }
   }
   setNotice(`${saved} actual ad-day spend records updated.${q.get('range')==='all'?' The all-time action imports the latest 30 days; select custom dates for older spend.':''}`);
  }catch(e){setNotice((e as Error).message);}finally{setSpending(false);void loadRef.current();}
 };
 const rows=(daily?data?.daily:data?.ads)||[],payers=(data?.pages||[]).reduce((n:number,p:any)=>n+Number(p.period_payments.confirmed),0);
 const visible=rows.filter((r:any)=>adFilter==='all'||JSON.stringify([r.page_id,r.ad_id])===adFilter).sort((a:any,b:any)=>(b.day||'').localeCompare(a.day||'')||b.leads-a.leads);
 return <section aria-label="Conversion performance" className="border border-black p-3 md:p-4 space-y-3 min-w-0">
  <div className="flex flex-wrap justify-between items-center gap-2"><div><h2 className="text-lg font-bold">{compact?'Today’s Page conversions':'Page and creative conversion summary'}</h2><p className="text-xs text-gray-600">Philippine Time · first documented payment or deposit per customer</p></div><div className="flex flex-wrap gap-2"><button className="border border-black px-2 py-1 text-sm disabled:opacity-40" onClick={()=>void load()} disabled={loading}>{loading?'Loading summary…':'Refresh summary'}</button><button className="border border-black px-2 py-1 text-sm disabled:opacity-40" onClick={()=>void verify()} disabled={refreshing}>{refreshing?'Verifying conversations…':'Verify latest conversations'}</button></div></div>
  {error&&<p role="alert" className="text-red-800">{error}{data?' Previous summary remains visible.':''}</p>}
  {notice&&<p role="status" className="text-sm">{notice}</p>}
  {!data?<p className="text-sm">{loading?'Loading payment evidence and original inquiry cohorts…':'Summary unavailable.'}</p>:<>
   <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm"><div className="bg-gray-50 border p-3">New inquiries in period <b className="block text-xl">{count(data.unique_contacts)}</b></div><div className="bg-gray-50 border p-3">Payment confirmations in period <b className="block text-xl">{count(payers)}</b><span className="text-xs">Includes customers who first inquired earlier.</span></div><div className="bg-gray-50 border p-3">Conversations awaiting verification <b className="block text-xl">{data.refresh_pending==null?'Unavailable':count(data.refresh_pending)}</b><span className="text-xs">Payment totals can increase after verification.</span></div></div>
   <p className="text-xs text-gray-600">The inquiry cohort stays tied to its original date. Its current conversion rate includes later payments from those same leads. Payment confirmations in the period are a separate measure. Average and median times below belong to customers whose first payment was confirmed in the selected period.</p>
   <div className="overflow-auto max-h-[500px] border"><table className="w-full text-sm"><thead className="bg-gray-100"><tr>{['Page','New inquiries','Payments in period','Avg. / median to payment','Cohort payers now','Current cohort rate','Projected by Day 30','Unverified cohort sources'].map(h=><th className="p-2 whitespace-nowrap text-left" key={h}>{h}</th>)}</tr></thead><tbody>{data.pages.map((r:any)=><tr key={r.page_id} className="border-t align-top"><td className="p-2 font-semibold whitespace-nowrap">{r.page.name}</td><td className="p-2">{count(r.leads)}</td><td className="p-2">{count(r.period_payments.confirmed)}</td><td className="p-2 whitespace-nowrap">{hours(r.period_payments.avg_hours)} / {hours(r.period_payments.median_hours)}</td><td className="p-2">{count(r.confirmed)}</td><td className="p-2">{pct(r.current_rate)}</td><td className="p-2 min-w-[160px]">{projected(r)}</td><td className="p-2">{count(r.unverified)}<p className="text-xs text-gray-500">{count(r.newer_activity)} with newer activity</p></td></tr>)}</tbody></table></div>
   {!compact&&<>
    <div className="flex flex-wrap items-end gap-3"><label className="text-sm">Creative report<select aria-label="Creative cohort view" className="block border p-2" value={daily?'daily':'total'} onChange={e=>setDaily(e.target.value==='daily')}><option value="daily">Each first-inquiry day</option><option value="total">Whole selected period</option></select></label><label className="text-sm max-w-full">Creative<select aria-label="Performance creative filter" className="block border p-2 max-w-[260px]" value={adFilter} onChange={e=>setAdFilter(e.target.value)}><option value="all">All creatives / unknown sources</option>{data.ads.map((r:any)=><option key={JSON.stringify([r.page_id,r.ad_id])} value={JSON.stringify([r.page_id,r.ad_id])}>{r.page?.name} · {r.ad?.ad_name||r.ad?.ad_title||r.ad_id||'Unknown source'}</option>)}</select></label><label className="text-sm">Target conversion rate<select aria-label="Target conversion rate" className="block border p-2" value={target} onChange={e=>setTarget(e.target.value)}>{['3','3.5','4','5','10'].map(v=><option key={v} value={v}>{v}%</option>)}</select></label><button className="border border-black px-2 py-2 text-sm disabled:opacity-40" disabled={spending||connection?.status!=='ready'} onClick={()=>void syncSpend()}>{spending?'Reading daily spend…':'Refresh actual daily spend'}</button></div>
    <p className="text-xs text-gray-600">Spend requires Facebook ad-account read access and imported ad IDs. Missing ad-days stay N/A. Different account-day boundaries are flagged instead of being treated as a Philippine day. Cost per inquiry uses verified source-linked contacts; source coverage may be incomplete.</p>
    <div className="overflow-auto max-h-[650px] border"><table className="w-full text-sm"><thead className="bg-gray-100"><tr>{['Page / ad','Inquiry day','Actual ad spend','Leads / qualified / not qualified','Confirmed cohort payers','Current rate','Avg. / median cohort conversion time','Projected Day 7 / 14 / 30','Target '+target+'%','Cost / linked lead','Cost / confirmed payer'].map(h=><th key={h} className="p-2 text-left whitespace-nowrap">{h}</th>)}</tr></thead><tbody>{visible.slice(offset,offset+100).map((r:any)=><tr key={JSON.stringify([r.page_id,r.ad_id,r.day])} className="border-t align-top"><td className="p-2 min-w-[180px]"><b>{r.ad?.ad_name||r.ad?.ad_title||(r.ad_id?'Ad '+r.ad_id:'Unknown originating ad')}</b><p className="text-xs">{r.page?.name}</p>{r.ad_id&&<p className="text-xs text-gray-500">ID {r.ad_id}</p>}<AdCreativePreview ad={r.ad||{}}/></td><td className="p-2 whitespace-nowrap">{r.day||'Selected period'}</td><td className="p-2 min-w-[150px]">{money(r.spend.amount,r.spend.currency)}{r.spend.amount==null&&r.spend.recorded_amount!=null&&<p className="text-xs">Recorded partial: {money(r.spend.recorded_amount,r.spend.currency)}</p>}<p className="text-xs text-gray-500">{r.spend.covered_days} / {r.spend.required_days??'?'} dates verified</p>{r.spend.timezone_mismatch&&<p className="text-xs text-amber-800">Account day differs from PHT</p>}{r.spend.checked_at&&<p className="text-xs text-gray-500">Checked {when(r.spend.checked_at)} PHT</p>}</td><td className="p-2">{count(r.leads)} / {count(r.qualified)} / {count(r.not_qualified)}</td><td className="p-2">{count(r.confirmed)}</td><td className="p-2">{pct(r.current_rate)}</td><td className="p-2 whitespace-nowrap">{hours(r.avg_hours)} / {hours(r.median_hours)}</td><td className="p-2 min-w-[180px]">{['168','336','720'].map(h=><p key={h}>Day {Number(h)/24}: {projected(r,h)}</p>)}</td><td className="p-2 min-w-[200px]">{targetText(r)}<p className="text-xs text-gray-500">{r.target.required_payers} confirmed payers needed out of {r.leads} leads.</p></td><td className="p-2">{money(r.cost_per_linked_inquiry,r.spend.currency)}</td><td className="p-2">{money(r.cost_per_confirmed_payer,r.spend.currency)}</td></tr>)}</tbody></table>{!visible.length&&<p className="p-3 text-sm">No creative cohorts or imported spend dates in this range.</p>}</div>
    <div className="flex gap-3 items-center text-sm"><button className="border px-2 py-1 disabled:opacity-40" disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-100))}>Previous creative rows</button><span>{visible.length?offset+1:0}–{Math.min(offset+100,visible.length)} of {count(visible.length)}</span><button className="border px-2 py-1 disabled:opacity-40" disabled={offset+100>=visible.length} onClick={()=>setOffset(offset+100)}>Next creative rows</button></div>
    <p className="text-xs text-gray-600">Day 7/14/30 means days from each lead’s first inquiry. Target timing describes when the expected rate crosses your target across those horizons; it is not the probability of actually reaching that target, a guaranteed closing date or a separately validated creative forecast. The forecast covers these existing leads and does not assume future inquiry volume. The five-Page contact model is aggregated here; it was not trained separately for each ad. Sources requiring verification keep the whole-cohort projection N/A.</p>
   </>}
   <div className="flex flex-wrap gap-4 text-xs text-gray-600"><span>Source summary checked: {when(data.generated_at)} PHT</span><label><input type="checkbox" checked={automatic} onChange={e=>setAutomatic(e.target.checked)}/> Update summary every minute; verify a small batch of today’s changed conversations</label></div>
  </>}
 </section>;
}
