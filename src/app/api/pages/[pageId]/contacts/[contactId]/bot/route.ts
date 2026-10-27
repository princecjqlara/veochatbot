import {NextRequest,NextResponse} from 'next/server';
import {getSessionFromRequest} from '@/lib/get-session';
import {userHasPageAccess} from '@/lib/page-access';
import {getSupabaseAdmin} from '@/lib/supabase';
export const dynamic='force-dynamic';
export async function PATCH(request:NextRequest,{params}:{params:Promise<{pageId:string;contactId:string}>}){
 const session=await getSessionFromRequest(request);
 if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
 if(request.headers.get('origin')!==request.nextUrl.origin)return NextResponse.json({error:'Same-origin request required'},{status:403});
 const {pageId,contactId}=await params;
 if(!await userHasPageAccess(session.user.id,pageId))return NextResponse.json({error:'Forbidden'},{status:403});
 let body;try{body=await request.json();}catch{return NextResponse.json({error:'Invalid JSON'},{status:400});}
 if(!body||typeof body!=='object'||typeof body.enabled!=='boolean')return NextResponse.json({error:'Choose bot on or off'},{status:400});
 const db=getSupabaseAdmin(),found=await db.from('contacts').select('id').eq('id',contactId).eq('page_id',pageId).maybeSingle();
 if(found.error)return NextResponse.json({error:'Could not verify contact'},{status:503});
 if(!found.data)return NextResponse.json({error:'Contact not found'},{status:404});
 const result=await db.rpc('set_contact_bot_permission',{p_page_id:pageId,p_contact_id:contactId,p_actor_id:session.user.id,p_enabled:body.enabled});
 if(result.error)return NextResponse.json({error:'Could not save contact bot permission'},{status:503});
 return NextResponse.json({...result.data,message:body.enabled?'Bot permission enabled. Page settings, handoffs and closed stages still apply.':'Bot disabled for this contact. Pending bot follow-ups were cancelled.'},{headers:{'Cache-Control':'no-store'}});
}
