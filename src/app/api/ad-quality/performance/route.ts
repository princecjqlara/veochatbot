import{NextRequest,NextResponse}from'next/server';
import{getSessionFromRequest}from'@/lib/get-session';
import{getUserPageIds}from'@/lib/page-access';
import{getSupabaseAdmin}from'@/lib/supabase';
import{adQualityRange}from'@/lib/ad-quality-range';
import{performanceAccumulator,targetRate,joinDailySpend,phtDate}from'@/lib/conversion-performance';
import{forecastPageName}from'@/lib/contact-forecast';
export const dynamic='force-dynamic';export const maxDuration=120;
export async function GET(request:NextRequest){
 const session=await getSessionFromRequest(request);if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
 let range,target;try{range=adQualityRange(request.nextUrl.searchParams);target=targetRate(request.nextUrl.searchParams);}catch(e){return NextResponse.json({error:(e as Error).message},{status:400});}
 try{
  const memberships=await getUserPageIds(session.user.id),selected=request.nextUrl.searchParams.get('pageId');
  if(selected&&!memberships.includes(selected))return NextResponse.json({error:'Forbidden'},{status:403});
  const ids=selected?[selected]:memberships;if(ids.length>50)return NextResponse.json({error:'Select a Page for this report'},{status:400});
  if(!ids.length)return NextResponse.json({range,pages:[],ads:[],daily:[],unique_contacts:0});
  const db=getSupabaseAdmin(),pages=await db.from('pages').select('id,name,fb_page_id').in('id',ids);if(pages.error)throw Error();
  const now=Date.parse(range.generated_at),acc=performanceAccumulator(pages.data||[],target),deadline=Date.now()+100_000;
  let after:string|null=null;
  for(let batch=0;batch<100;batch++){
   const input:{data:any;error:any}=await db.rpc('get_conversion_report_inputs',{p_page_ids:ids,p_from:range.from,p_to:range.to,p_after:after,p_limit:1000});if(input.error)throw Error();
   for(const r of input.data?.rows||[])acc.add(r,now);
   if(!input.data?.has_more)break;
   if(!input.data.next_after||input.data.next_after===after||Date.now()>deadline||batch===99)throw Error('Choose a shorter date range to complete the report. No partial totals are displayed.');
   after=input.data.next_after;
  }
  const supportedIds=(pages.data||[]).filter(p=>forecastPageName(p.fb_page_id)).map(p=>p.id);
  const [payments,catalog,pending]=await Promise.all([
   db.rpc('get_conversion_period_payments',{p_page_ids:ids,p_from:range.from,p_to:range.to}),
   db.rpc('get_visible_ad_catalog',{p_page_ids:ids,p_from:range.from,p_to:range.to}),
   supportedIds.length?db.rpc('get_conversion_refresh_candidates',{p_page_ids:supportedIds,p_from:range.from,p_to:range.to,p_skip:[],p_limit:1}):Promise.resolve({data:{pending:0},error:null})
  ]);if(payments.error||catalog.error)throw Error();
  const spend:any[]=[];
  for(let offset=0;offset<100_000;offset+=1000){
   let q=db.from('ad_daily_spend').select('*').in('page_id',ids).lte('spend_date',phtDate(Date.parse(range.to)-1)).order('page_id').order('ad_id').order('spend_date').order('account_id').range(offset,offset+999);
   if(range.from)q=q.gte('spend_date',phtDate(Date.parse(range.from)));const result=await q;if(result.error)throw Error();spend.push(...result.data||[]);if((result.data||[]).length<1000)break;if(offset===99000)throw Error('Select a shorter range for daily spend.');
  }
  const data=acc.result(),pageNames=new Map((pages.data||[]).map(p=>[p.id,p]));
  // Preserve zero-lead inventory and actual spend days without inventing contacts.
  const known=new Set(data.ads.map(a=>JSON.stringify([a.page_id,a.ad_id])));
  for(const a of catalog.data||[]){const key=JSON.stringify([a.page_id,a.ad_id]);if(!known.has(key)){data.ads.push({...performanceAccumulator([{id:a.page_id,fb_page_id:pageNames.get(a.page_id)?.fb_page_id||''}],target).result().pages[0],ad_id:a.ad_id});known.add(key);}}
  const dayKeys=new Set(data.daily.map(a=>JSON.stringify([a.page_id,a.ad_id,a.day])));
  if(range.from&&Date.parse(range.to)-Date.parse(range.from)<=31*86_400_000){
   for(const ad of catalog.data||[]){
    for(let start=Date.parse(range.from);start<Date.parse(range.to);start+=86_400_000){
     const day=phtDate(start),key=JSON.stringify([ad.page_id,ad.ad_id,day]);
     if(!dayKeys.has(key)){data.daily.push({...performanceAccumulator([{id:ad.page_id,fb_page_id:pageNames.get(ad.page_id)?.fb_page_id||''}],target).result().pages[0],ad_id:ad.ad_id,day});dayKeys.add(key);}
    }
   }
  }
  for(const s of spend){const key=JSON.stringify([s.page_id,s.ad_id,s.spend_date]);if(!dayKeys.has(key)){data.daily.push({...performanceAccumulator([{id:s.page_id,fb_page_id:pageNames.get(s.page_id)?.fb_page_id||''}],target).result().pages[0],ad_id:s.ad_id,day:s.spend_date});dayKeys.add(key);}}
  const meta=new Map((catalog.data||[]).map((a:any)=>[JSON.stringify([a.page_id,a.ad_id]),a]));
  const decorate=(r:any)=>({...r,page:pageNames.get(r.page_id),ad:meta.get(JSON.stringify([r.page_id,r.ad_id]))||null});
  return NextResponse.json({range,target_rate:target,generated_at:range.generated_at,model_version:'dd7f0ca783ad1651',
   pages:data.pages.map(p=>({...p,page:pageNames.get(p.page_id),period_payments:(payments.data||[]).find((x:any)=>x.page_id===p.page_id)||{confirmed:0,avg_hours:null,median_hours:null}})),
   ads:joinDailySpend(data.ads,spend,range).map(decorate),daily:joinDailySpend(data.daily,spend,range).map(decorate),unique_contacts:data.unique_contacts,refresh_pending:pending.error?null:Number(pending.data?.pending||0),
   note:'Payment counts use documented first payment/deposit confirmation. Current cohort rates include later payments from the original inquiry cohort. Forecasts end 7/14/30 days after each first inquiry; missing or outdated sources are not counted as nonbuyers. Target timing is an expected horizon, not a guaranteed or separately backtested threshold-crossing date.'
  },{headers:{'Cache-Control':'no-store'}});
 }catch(e){return NextResponse.json({error:(e as Error).message||'Conversion performance is temporarily unavailable'},{status:503});}
}
