export type ForecastSnapshot={h:number;i:string;s:string;b:string;industry_evidence_ms?:number|null};
export type ForecastCache={contact_id:string;page_id:string;first_inquiry_at:string;first_message_id?:string|null;source_cutoff_at:string;snapshots:ForecastSnapshot[];payment_at:string|null;payment_evidence_id:string|null;source_kind:string;complete_history:boolean;dirty_at:string|null};
type Cell=[number,number,number];
type Model={version:string;mode:string;strength:number;hazard_factor:number;edges_hours:number[];counts:Record<string,Record<string,Cell[]>>};
// A static server-only require keeps TypeScript from expanding thousands of
// aggregate model keys into a giant inferred type. The asset is traced by Next.
const model=require('./conversion-runtime/model.json') as Model,HOUR=3_600_000,UNKNOWN='Unknown / insufficient business detail';
const key=(x:string[])=>JSON.stringify(x).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
export function forecastPageName(id:string){return ({'656646850875530':'Azshinari','717828411409985':'SAMA KANA MEDIA','725843003947429':'Vista Media Agency','619355471260631':'Manawari Studios','781078668411527':'Loki Media'} as Record<string,string>)[id]||'';}
const date=(ms:number)=>new Date(ms+8*HOUR).toISOString().slice(0,10);
function levels(page:string,f:ForecastSnapshot){
 const groups=[['all'],['all',page]],base=['all',page,f.b];
 if(model.mode==='page')return groups;
 groups.push(base);
 if(f.i!==UNKNOWN){groups.push([...base,f.i]);if(f.s!=='Unknown')groups.push([...base,f.i,f.s]);}
 return groups;
}
function integrate(rates:number[],start:number,end:number){return rates.reduce((sum,r,j)=>sum+r*Math.max(0,Math.min(model.edges_hours[j+1],end)-Math.max(model.edges_hours[j],start)),0);}
export function scoreContactForecast(cache:ForecastCache|null,pageName:string,now=Date.now()){
 if(!model.counts['0']?.[key(['all',pageName])])return {status:'unsupported_page',needs_refresh:false,message:'This Page is outside the five-Page historical training set.',model_version:model.version};
 if(!cache)return {status:'needs_source',needs_refresh:true,message:'Refresh the verified conversation to calculate this projection.',model_version:model.version};
 if(!cache.complete_history)return {status:'incomplete_history',needs_refresh:true,message:'A complete source history is required for this projection.',model_version:model.version};
 const first=Date.parse(cache.first_inquiry_at),asof=Date.parse(cache.source_cutoff_at),age=(asof-first)/HOUR;
 if(!Number.isFinite(first)||!Number.isFinite(asof)||age<0)return {status:'invalid_source',needs_refresh:true,model_version:model.version};
 const payment=cache.payment_at?Date.parse(cache.payment_at):null,knownPayment=payment!=null&&payment<=asof&&!!cache.payment_evidence_id;
 const stale=now-asof>120_000||!!cache.dirty_at&&Date.parse(cache.dirty_at)>asof;
 const f=[...cache.snapshots].filter(s=>s.h<=age).sort((a,b)=>b.h-a.h)[0];
 const scores:Record<string,any>={};let window:any=null;
 let rates:number[]=[];let support:any=null;
 if(f){
  const groups=model.counts[String(f.h)]||{},ks=levels(pageName,f);
  rates=model.edges_hours.slice(0,-1).map((a,j)=>{
   const width=model.edges_hours[j+1]-a;let rate=0,deep=null;
   for(let d=0;d<ks.length;d++){
    const [y,t,n]=groups[key(ks[d])]?.[j]||[0,0,0];
    if(d===0)rate=t?(y+.5)/(t+.5*width):0;
    else if(t){const prior=model.strength*width;rate=(y+rate*prior)/(t+prior);}
    if(n)deep={comparable_records:n,events:y,group:ks[d]};
   }
   if(a===f.h)support=deep;
   return Math.max(0,rate)*model.hazard_factor;
  });
 }
 for(const h of [168,336,720]){
  if(knownPayment){scores[String(h)]={status:'confirmed',probability:Number(payment!-first<=h*HOUR),future_probability:0};continue;}
  if(age>=h){scores[String(h)]={status:'window_ended',probability:0,future_probability:0};continue;}
  const root=f?model.counts[String(f.h)]?.[key(['all'])]:null;
  if(!f||!root||model.edges_hours.slice(0,-1).some((a,j)=>Math.min(model.edges_hours[j+1],h)>Math.max(a,age)&&root[j][1]<=0)){
   scores[String(h)]={status:'insufficient_support',probability:null,future_probability:null};continue;
  }
  const p=-Math.expm1(-Math.min(700,integrate(rates,age,h)));scores[String(h)]={status:'estimated',probability:p,future_probability:p};
  if(h===720&&p>0&&support&&support.comparable_records>=30){
   const quantile=(q:number)=>{const target=-Math.log1p(-q*p);let lo=age,hi=h;for(let i=0;i<42;i++){const mid=(lo+hi)/2;if(integrate(rates,age,mid)<target)lo=mid;else hi=mid;}return(lo+hi)/2;};
   const median=quantile(.5),q1=quantile(.25),q3=quantile(.75);
   window={median_date_pht:date(first+median*HOUR),middle50_dates_pht:[date(first+q1*HOUR),date(first+q3*HOUR)],median_remaining_days:(median-age)/24,middle50_remaining_days:[(q1-age)/24,(q3-age)/24],conditional_on_payment_by_day30:true};
  }
 }
 return {status:knownPayment?'documented_confirmation':age>=720?'window_ended':'estimated',needs_refresh:!knownPayment&&stale&&age<720,stale,model_version:model.version,as_of:cache.source_cutoff_at,first_inquiry_at:cache.first_inquiry_at,payment_at:cache.payment_at,payment_evidence_id:cache.payment_evidence_id,source_kind:cache.source_kind,scores,close_window:window,checkpoint_hours:f?.h??null,checkpoint_at:f?new Date(first+f.h*HOUR).toISOString():null,industry:f?.i||UNKNOWN,subtype:f?.s||'Unknown',behavior:f?.b||'unavailable',support,
  limitation:'Experimental payment/deposit confirmation forecast. Day-30 conditional timing MAE was 6.48 days for 52 supported later payers. Closed windows do not mean never buying.'};
}
