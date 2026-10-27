import{NextRequest,NextResponse}from'next/server';
import{getSessionFromRequest}from'@/lib/get-session';
import{userHasPageAccess}from'@/lib/page-access';
import{getSupabaseAdmin}from'@/lib/supabase';
import{contactControls}from'@/lib/contact-controls';
import{refreshContactProjection}from'@/lib/contact-projection-refresh';
export const dynamic='force-dynamic';export const maxDuration=120;
async function authorize(request:NextRequest,params:Promise<{pageId:string;contactId:string}>){
 const session=await getSessionFromRequest(request);if(!session?.user?.id)return{error:NextResponse.json({error:'Unauthorized'},{status:401})};
 const scope=await params;if(!await userHasPageAccess(session.user.id,scope.pageId))return{error:NextResponse.json({error:'Forbidden'},{status:403})};return scope;
}
export async function GET(request:NextRequest,{params}:{params:Promise<{pageId:string;contactId:string}>}){
 const auth=await authorize(request,params);if('error'in auth)return auth.error;
 try{const result=(await contactControls(getSupabaseAdmin(),auth.pageId,[auth.contactId])).get(auth.contactId);if(!result)return NextResponse.json({error:'Contact not found'},{status:404});return NextResponse.json(result,{headers:{'Cache-Control':'no-store'}});}
 catch{return NextResponse.json({error:'Contact controls temporarily unavailable'},{status:503});}
}
export async function POST(request:NextRequest,{params}:{params:Promise<{pageId:string;contactId:string}>}){
 const auth=await authorize(request,params);if('error'in auth)return auth.error;
 if(request.headers.get('origin')!==request.nextUrl.origin)return NextResponse.json({error:'Same-origin request required'},{status:403});
 try{return NextResponse.json({conversion_projection:await refreshContactProjection(getSupabaseAdmin(),auth.pageId,auth.contactId)},{headers:{'Cache-Control':'no-store'}});}
 catch(e){return NextResponse.json({error:(e as Error).message},{status:503});}
}
