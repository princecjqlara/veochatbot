import { NextRequest } from 'next/server';
import { connectOwnerPage } from '@/lib/veo-connect-page';
import { pageSetupFailure } from '@/lib/veo-page-connections';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;
export async function POST(request: NextRequest) {
    try { return await connectOwnerPage(request); }
    catch (error) { return pageSetupFailure(error); }
}
