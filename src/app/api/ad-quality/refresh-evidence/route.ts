import{NextRequest,NextResponse}from'next/server';
import{getSessionFromRequest}from'@/lib/get-session';
import{getUserPageIds}from'@/lib/page-access';
import{getSupabaseAdmin}from'@/lib/supabase';
import{adQualityRange}from'@/lib/ad-quality-range';
import{forecastPageName}from'@/lib/contact-forecast';
import{refreshContactProjection}from'@/lib/contact-projection-refresh';
export const dynamic='force-dynamic';export const maxDuration=120;
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export async function POST(request:NextRequest){
 const session=await getSessionFromRequest(request);if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
 if(request.headers.get('origin')!==request.nextUrl.origin)return NextResponse.json({error:'Same-origin request required'},{status:403});
 let range,body;try{range=adQualityRange(request.nextUrl.searchParams);body=await request.json();if(!body||!Array.isArray(body.skip)||body.skip.length>500||!body.skip.every(uuid))throw Error('Invalid evidence refresh batch');}catch(e){return NextResponse.json({error:(e as Error).message},{status:400});}
 const memberships=await getUserPageIds(session.user.id),selected=request.nextUrl.searchParams.get('pageId');if(selected&&!memberships.includes(selected))return NextResponse.json({error:'Forbidden'},{status:403});
 try{
  const db=getSupabaseAdmin(),pages=await db.from('pages').select('id,fb_page_id').in('id',selected?[selected]:memberships);if(pages.error)throw Error();
  const ids=(pages.data||[]).filter(p=>forecastPageName(p.fb_page_id)).map(p=>p.id);
  if(!ids.length)return NextResponse.json({processed:[],failed:[],pending:0,unsupported:true});
  const candidates=await db.rpc('get_conversion_refresh_candidates',{p_page_ids:ids,p_from:range.from,p_to:range.to,p_skip:body.skip,p_limit:8});if(candidates.error)throw Error();
  const processed:string[]=[],failed:string[]=[];let index=0;const rows=candidates.data?.contacts||[],deadline=Date.now()+90_000;
  await Promise.all([0,1].map(async()=>{while(index<rows.length&&Date.now()<deadline){const c=rows[index++];try{await refreshContactProjection(db,c.page_id,c.id,true);processed.push(c.id);}catch{failed.push(c.id);}}}));
  return NextResponse.json({processed,failed,pending:Math.max(0,Number(candidates.data?.pending||0)-processed.length-failed.length),messages_sent:0},{headers:{'Cache-Control':'no-store'}});
 }catch{return NextResponse.json({error:'Verified conversation refresh is temporarily unavailable'},{status:503});}
}
