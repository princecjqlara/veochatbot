import{NextRequest,NextResponse}from'next/server';
import{getSessionFromRequest}from'@/lib/get-session';
import{getUserPageIds}from'@/lib/page-access';
import{getSupabaseAdmin}from'@/lib/supabase';
import{adQualityRange}from'@/lib/ad-quality-range';
import{phtDate}from'@/lib/conversion-performance';
import{readMetaAds,MetaAdAccessError}from'@/lib/facebook-ad-catalog';
import{normalizeDailySpend}from'@/lib/ad-daily-spend';
export const dynamic='force-dynamic';export const maxDuration=60;
export async function POST(request:NextRequest){
 const session=await getSessionFromRequest(request);if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
 if(request.headers.get('origin')!==request.nextUrl.origin)return NextResponse.json({error:'Same-origin request required'},{status:403});
 let body,from:string,to:string;try{
  body=await request.json();if(!body||!/^act_[0-9]+$/.test(body.accountId||'')||body.after!=null&&(typeof body.after!=='string'||body.after.length>4096))throw Error('Choose an ad account');
  const range=adQualityRange(new URLSearchParams({range:'custom',from:body.from||'',to:body.to||''}));from=phtDate(Date.parse(range.from!));to=phtDate(Date.parse(range.to)-1);
  if(Date.parse(to)-Date.parse(from)>30*86_400_000)throw Error('Import at most 31 daily reporting dates per batch');
 }catch(e){return NextResponse.json({error:(e as Error).message},{status:400});}
 const memberships=await getUserPageIds(session.user.id);if(body.pageId&&!memberships.includes(body.pageId))return NextResponse.json({error:'Forbidden'},{status:403});
 if(!session.accessToken)return NextResponse.json({error:'Connect Facebook ad details with ad-account read access, then import ads before refreshing spend.',requiresReconnect:true},{status:409});
 try{
  const db=getSupabaseAdmin(),ids=body.pageId?[body.pageId]:memberships;
  const catalog=await db.rpc('get_visible_ad_catalog',{p_page_ids:ids,p_from:null,p_to:new Date().toISOString()});if(catalog.error)throw Error('Could not verify ad ownership');
  const allowed=new Map<string,string>((catalog.data||[]).filter((a:any)=>a.ad_account_id===body.accountId.replace(/^act_/, '')).map((a:any)=>[a.ad_id,a.page_id]));
  if(!allowed.size)return NextResponse.json({error:'Import Facebook ads first so ad IDs can be verified against your Pages.',errorCode:'NO_VERIFIED_PAGE_ADS'},{status:409});
  const account=await readMetaAds(body.accountId,session.accessToken,{fields:'id,currency,timezone_name'});
  if(account.id!==body.accountId||typeof account.currency!=='string'||typeof account.timezone_name!=='string')throw Error('Ad-account currency or timezone could not be verified');
  const result=await readMetaAds(body.accountId+'/insights',session.accessToken,{fields:'ad_id,account_id,account_currency,date_start,date_stop,spend,impressions,clicks',level:'ad',time_increment:'1',time_range:JSON.stringify({since:from,until:to}),limit:'100',...(body.after?{after:body.after}:{})});
  const records=(result.data||[]).map((r:any)=>normalizeDailySpend(r,account,allowed,from,to)).filter(Boolean);
  if(records.length){const saved=await db.from('ad_daily_spend').upsert(records,{onConflict:'page_id,ad_id,spend_date,account_id'});if(saved.error)throw Error('Could not save daily spend');}
  const after=result.paging?.next?result.paging?.cursors?.after||null:null;
  return NextResponse.json({read:(result.data||[]).length,saved:records.length,timezone:account.timezone_name,currency:account.currency,pht_aligned:records.every((r:any)=>r.pht_aligned),nextAfter:after,complete:!result.paging?.next,paginationUnavailable:!!result.paging?.next&&!after,missing_days_are_zero:false},{headers:{'Cache-Control':'no-store'}});
 }catch(e){const error=e as MetaAdAccessError;return NextResponse.json({error:error.message||'Daily spend is temporarily unavailable',requiresReconnect:!!error.reconnect},{status:error.reconnect?409:503});}
}
