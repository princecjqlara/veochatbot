import { NextRequest } from 'next/server';
import { beginFacebookPageAuthorization } from '@/lib/facebook-page-authorization';
import { pageSetupFailure } from '@/lib/veo-page-connections';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
    try { return await beginFacebookPageAuthorization(request); }
    catch (error) { return pageSetupFailure(error); }
}
