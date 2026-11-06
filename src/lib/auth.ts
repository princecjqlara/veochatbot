import { NextAuthOptions } from 'next-auth';
import FacebookProvider from 'next-auth/providers/facebook';
import CredentialsProvider from 'next-auth/providers/credentials';
import { cookies } from 'next/headers';
import { createHash } from 'node:crypto';
import { getSupabaseAdmin } from './supabase';
import { FACEBOOK_PERMISSION_SCOPE } from './facebook-permissions';
import { CJ_OWNER_USER_ID } from '@/config/veo-owner';
import { passwordMatches, roles, workspaceEnabled, workspaceScope, type WorkspaceRole } from './veo-workspace';

async function facebookOwner(account: any) {
    const db = getSupabaseAdmin();
    const byId = await db.from('users').select('id,facebook_id,is_active').eq('facebook_id', account.providerAccountId).maybeSingle();
    if (byId.error || !byId.data?.is_active || byId.data.id !== CJ_OWNER_USER_ID || byId.data.facebook_id !== account.providerAccountId) return null;
    const scope = await workspaceScope(CJ_OWNER_USER_ID).catch(() => null);
    return scope?.role === 'owner' && scope.launch_at ? byId.data : null;
}
export const authOptions: NextAuthOptions = {
    providers: [
        CredentialsProvider({ name: 'VEO account', credentials: { email: { type: 'email' }, password: { type: 'password' }, role: { type: 'text' } },
            async authorize(credentials) {
                if (!credentials || !roles.includes(credentials.role as WorkspaceRole) || !credentials.password || !credentials.email) return null;
                const db = getSupabaseAdmin(), email = credentials.email.trim().toLowerCase();
                const key = createHash('sha256').update(email).digest('hex');
                const limit = await db.rpc('veo_login_attempt', { p_key: key });
                if (limit.error || limit.data !== true) return null;
                const row = await db.from('users').select('id,name,email,image,password_hash,is_active').eq('email', email).maybeSingle();
                if (row.error || !row.data?.is_active || !await passwordMatches(credentials.password, row.data.password_hash)) return null;
                const scope = await workspaceScope(row.data.id);
                if (!scope || scope.role !== credentials.role) return null;
                return { id: row.data.id, name: row.data.name, email: row.data.email, image: row.data.image };
            }
        }),
        FacebookProvider({ clientId: process.env.FACEBOOK_CLIENT_ID!, clientSecret: process.env.FACEBOOK_CLIENT_SECRET!, authorization: { params: { scope: FACEBOOK_PERMISSION_SCOPE } } })
    ],
    callbacks: {
        async signIn({ account }) {
            if (account?.provider !== 'facebook') return true;
            if (cookies().get('veo-login-role')?.value !== 'owner') return false;
            return Boolean(await facebookOwner(account));
        },
        async jwt({ token, account, user }) {
            if (account && user) {
                token.loginStartedAt = Date.now();
                if (account.provider === 'facebook') {
                    const existing = await facebookOwner(account);
                    if (!existing) return {};
                    token.id = existing.id;
                    token.accessToken = account.access_token;
                    token.facebookId = account.providerAccountId;
                    if (typeof account.expires_at === 'number') token.accessTokenExpiresAt = account.expires_at * 1000;
                } else {
                    token.id = user.id;
                    delete token.facebookId;
                    delete token.accessToken;
                    delete token.accessTokenExpiresAt;
                }
            }
            if (token.facebookId && token.id !== CJ_OWNER_USER_ID) return {};
            return token;
        },
        async session({ session, token }) {
            const scope = workspaceEnabled() && token.id ? await workspaceScope(token.id).catch(() => null) : null;
            return { ...session, accessToken: token.accessToken as string,
                accessTokenExpiresAt: typeof token.accessTokenExpiresAt === 'number' ? new Date(token.accessTokenExpiresAt).toISOString() : undefined,
                user: { ...session.user, id: workspaceEnabled() && !scope ? undefined : token.id, role: scope?.role, facebookId: token.facebookId,
                    telegramUsername: scope?.telegram_username || null,
                    telegramProfileCompleted: Boolean(scope?.telegram_profile_completed_at),
                    telegramProfileConfirmed: Boolean(scope?.telegram_profile_completed_at && (!token.loginStartedAt || Date.parse(scope.telegram_profile_completed_at) >= token.loginStartedAt)) } };
        }
    },
    pages: { signIn: '/', error: '/' },
    session: { strategy: 'jwt', maxAge: 30 * 24 * 60 * 60 },
    debug: false
};
declare module 'next-auth' {
    interface Session {
        accessToken?: string;
        accessTokenExpiresAt?: string;
        user: { id?: string; role?: WorkspaceRole; name?: string | null; email?: string | null; image?: string | null; facebookId?: string; telegramUsername?: string | null; telegramProfileCompleted?: boolean; telegramProfileConfirmed?: boolean };
    }
}
declare module 'next-auth/jwt' {
    interface JWT { id?: string; accessToken?: string; accessTokenExpiresAt?: number; facebookId?: string; loginStartedAt?: number }
}
