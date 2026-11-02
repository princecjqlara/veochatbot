import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getFacebookPages, isFacebookReauthRequired } from '@/lib/facebook';
import { FACEBOOK_REAUTH_MESSAGE } from '@/lib/facebook-permissions';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// GET /api/facebook/pages - Get user's Facebook pages
export async function GET(request: NextRequest) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        // Note: Facebook pages functionality requires Facebook OAuth
        // With email/password login, this endpoint returns empty pages
        // Pages should be connected via the admin or API with stored tokens
        if (!session.accessToken) {
            return NextResponse.json({ error: 'Facebook authorization required', pages: [], code: 'FACEBOOK_REAUTH_REQUIRED', requiresReauth: true, message: 'Use Refresh Permissions to sign in with Facebook and grant access to your Pages.' }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
        }

        const pages = await getFacebookPages(session.accessToken);

        return NextResponse.json({ pages }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
        console.error('Error fetching Facebook pages:', error);
        if (isFacebookReauthRequired(error)) {
            return NextResponse.json(
                {
                    error: 'Facebook authorization required',
                    code: 'FACEBOOK_REAUTH_REQUIRED',
                    requiresReauth: true,
                    message: FACEBOOK_REAUTH_MESSAGE
                },
                { status: 409 }
            );
        }

        return NextResponse.json(
            { error: 'Failed to fetch pages', message: (error as Error).message },
            { status: 500 }
        );
    }
}
