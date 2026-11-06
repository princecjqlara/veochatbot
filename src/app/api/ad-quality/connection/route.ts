import{NextRequest,NextResponse}from'next/server';
import{getSessionFromRequest}from'@/lib/get-session';
import{marketingConnection}from'@/lib/facebook-ad-catalog';
import{getSupabaseAdmin}from'@/lib/supabase';
import{encryptMetaAdsToken}from'@/lib/meta-ads-credentials';
import{workspaceEnabled}from'@/lib/veo-workspace';
export const dynamic='force-dynamic';export const maxDuration=60;
export async function GET(request:NextRequest){const session=await getSessionFromRequest(request);if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
 if(workspaceEnabled())return NextResponse.json({status:'saved_data',accounts:[],readOnlyReports:true,message:'Showing saved calendar, spend and ad-performance data for your authorized Pages. Missing or stale values remain unavailable. Facebook sign-in is disabled; existing background Page collection continues.'},{headers:{'Cache-Control':'no-store'}});
 const status=await marketingConnection(session.accessToken);let credentialSaved=false;
 if(status.status==='ready'&&session.accessToken){try{const encrypted=encryptMetaAdsToken(session.accessToken),saved=await getSupabaseAdmin().from('meta_ads_credentials').upsert({user_id:session.user.id,...encrypted,token_expires_at:session.accessTokenExpiresAt||null,permissions:(status as any).permissions||[],last_error:null,updated_at:new Date().toISOString()},{onConflict:'user_id'});credentialSaved=!saved.error;if(saved.error)console.error('Meta Ads credential could not be retained for scheduled sync');}catch{console.error('Meta Ads credential encryption is unavailable');}}
 return NextResponse.json({...status,credentialSaved,...(status.status==='ready'&&!credentialSaved?{message:'Ad account access works for this session, but scheduled sync could not save its encrypted credential. Contact support.'}:{})},{headers:{'Cache-Control':'no-store'}});}
