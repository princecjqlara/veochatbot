import{NextRequest,NextResponse}from'next/server';
import{getSessionFromRequest}from'@/lib/get-session';
import{getUserPageIds}from'@/lib/page-access';
import{getSupabaseAdmin}from'@/lib/supabase';
import{readMetaAds,creativePageId,catalogMetadata,MetaAdAccessError}from'@/lib/facebook-ad-catalog';
export const dynamic='force-dynamic';export const maxDuration=60;
export async function POST(request:NextRequest){
 const session=await getSessionFromRequest(request);if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
 if(request.headers.get('origin')!==request.nextUrl.origin)return NextResponse.json({error:'Same-origin request required'},{status:403});
 let body;try{body=await request.json();}catch{return NextResponse.json({error:'Invalid JSON'},{status:400});}
 if(!body||!/^act_\d{1,100}$/.test(body.accountId||'')||body.after!=null&&(typeof body.after!=='string'||body.after.length>4096))return NextResponse.json({error:'Choose a Facebook ad account'},{status:400});
 const ids=await getUserPageIds(session.user.id);if(body.pageId&&!ids.includes(body.pageId))return NextResponse.json({error:'Forbidden'},{status:403});
 if(!session.accessToken)return NextResponse.json({error:'Connect Facebook ad-account read access first',requiresReconnect:true},{status:409});
 const db=getSupabaseAdmin(),pages=await db.from('pages').select('id,fb_page_id').in('id',body.pageId?[body.pageId]:ids);if(pages.error)return NextResponse.json({error:'Could not load your Pages'},{status:503});
 const allowed=new Map((pages.data||[]).map(p=>[p.fb_page_id,p.id]));
 try{
  const result=await readMetaAds(body.accountId+'/ads',session.accessToken,{fields:'id,name,account_id,effective_status,campaign{id,name},adset{id,name},creative{id,name,thumbnail_url,effective_object_story_id,object_story_id,object_story_spec}',limit:'100',...(body.after?{after:body.after}:{})});
  const records=[];let skipped=0;
  for(const ad of result.data||[]){const page=creativePageId(ad),id=page&&allowed.get(page);if(!id||typeof ad.id!=='string'||!/^\d+$/.test(ad.id)){skipped++;continue;}records.push(catalogMetadata(ad,id));}
  if(records.length){const saved=await db.rpc('save_ad_catalog_metadata',{p_records:records});if(saved.error)return NextResponse.json({error:'Could not save ad inventory'},{status:503});}
  const after=result.paging?.next?result.paging?.cursors?.after||null:null;
  return NextResponse.json({read:(result.data||[]).length,saved:records.length,skipped,nextAfter:after,complete:!result.paging?.next,paginationUnavailable:!!result.paging?.next&&!after,note:'Ads are linked only by verified creative Page IDs. Importing inventory does not assign contacts to ads.'});
 }catch(e){const error=e as MetaAdAccessError;return NextResponse.json({error:error.message,errorCode:error.code,requiresReconnect:error.reconnect},{status:error.reconnect?409:503});}
}
