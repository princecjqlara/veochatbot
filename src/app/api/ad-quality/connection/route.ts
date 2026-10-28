import{NextRequest,NextResponse}from'next/server';
import{getSessionFromRequest}from'@/lib/get-session';
import{marketingConnection}from'@/lib/facebook-ad-catalog';
export const dynamic='force-dynamic';
export async function GET(request:NextRequest){const session=await getSessionFromRequest(request);if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});return NextResponse.json(await marketingConnection(session.accessToken),{headers:{'Cache-Control':'no-store'}});}
