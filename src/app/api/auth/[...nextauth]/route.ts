import NextAuth from 'next-auth';
import { authOptions } from '@/lib/auth';
import { NextRequest } from 'next/server';
import { finishFacebookPageAuthorization } from '@/lib/facebook-page-authorization';

const handler = NextAuth(authOptions);
export const maxDuration = 120;

export async function GET(request: NextRequest, context: any) {
    if (request.nextUrl.pathname === '/api/auth/callback/facebook') return finishFacebookPageAuthorization(request);
    return handler(request, context);
}
export { handler as POST };
