import{NextRequest,NextResponse}from'next/server';
import{getSessionFromRequest}from'@/lib/get-session';
import{userHasPageAccess}from'@/lib/page-access';
import{getSupabaseAdmin}from'@/lib/supabase';
import{resolveAdCreative}from'@/lib/facebook-ad-catalog';
export const dynamic='force-dynamic';export const maxDuration=120;
export async function POST(request:NextRequest){
 const session=await getSessionFromRequest(request);if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
 if(request.headers.get('origin')!==request.nextUrl.origin)return NextResponse.json({error:'Same-origin request required'},{status:403});
 let body;try{body=await request.json();}catch{return NextResponse.json({error:'Invalid JSON'},{status:400});}
 if(!body||typeof body.pageId!=='string'||!Array.isArray(body.adIds)||body.adIds.length>20||!body.adIds.every((x:unknown)=>typeof x==='string'&&/^\d{1,100}$/.test(x)))return NextResponse.json({error:'Choose at most 20 recorded ad IDs'},{status:400});
 if(!await userHasPageAccess(session.user.id,body.pageId))return NextResponse.json({error:'Forbidden'},{status:403});
 const db=getSupabaseAdmin(),[pageResult,known]=await Promise.all([db.from('pages').select('fb_page_id,access_token').eq('id',body.pageId).maybeSingle(),db.from('ad_source_catalog').select('ad_id,post_id').eq('page_id',body.pageId).in('ad_id',body.adIds)]);
 if(pageResult.error||known.error)return NextResponse.json({error:'Could not load recorded ads'},{status:503});
 const page=pageResult.data;if(!page)return NextResponse.json({error:'Page not found'},{status:404});
 const ads=known.data||[],results:any[]=new Array(ads.length),patches:any[]=[];let next=0;const deadline=Date.now()+85_000;
 await Promise.all(Array.from({length:Math.min(3,ads.length)},async()=>{while(next<ads.length){const index=next++,ad=ads[index];if(Date.now()>deadline){results[index]={adId:ad.ad_id,resolved:false,status:'time_limit'};continue;}try{const result=await resolveAdCreative({pageId:body.pageId,facebookPageId:page.fb_page_id,pageToken:page.access_token,userToken:session.accessToken,ad});patches.push(result.patch);results[index]={adId:ad.ad_id,resolved:result.resolved,source:result.source};}catch{results[index]={adId:ad.ad_id,resolved:false,status:'temporarily_unavailable'};}}}));
 if(patches.length){const saved=await db.rpc('save_ad_catalog_metadata',{p_records:patches});if(saved.error)return NextResponse.json({error:'Could not save verified ad previews'},{status:503});}
 return NextResponse.json({results,note:'Page-post previews can load with Page access. Full Ads Manager names and inventory need ad-account read access. No contact origin was changed.'});
}
