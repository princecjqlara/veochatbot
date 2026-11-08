import { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { createHash } from 'node:crypto';
import { getSupabaseAdmin } from './supabase';
import { passwordMatches, roles, workspaceEnabled, workspaceScope, type WorkspaceRole } from './veo-workspace';
import { requestDeadline } from './request-deadline';
import { isSupabaseUnavailable } from './supabase-errors';

export const authOptions: NextAuthOptions = {
    providers: [
        CredentialsProvider({ name: 'VEO account', credentials: { email: { type: 'email' }, password: { type: 'password' } },
            async authorize(credentials) {
                if (!credentials || !credentials.password || !credentials.email) return null;
                try {
                    return await requestDeadline(async signal => {
                        const db = getSupabaseAdmin(signal), email = credentials.email.trim().toLowerCase();
                        const key = createHash('sha256').update(email).digest('hex');
                        const limit = await db.rpc('veo_login_attempt', { p_key: key });
                        if (limit.error) throw new Error('DatabaseUnavailable');
                        if (limit.data !== true) throw new Error('TooManyAttempts');
                        const row = await db.from('users').select('id,name,email,image,password_hash,is_active').eq('email', email).maybeSingle();
                        if (row.error) throw new Error('DatabaseUnavailable');
                        if (!row.data?.is_active || !await passwordMatches(credentials.password!, row.data.password_hash)) return null;
                        const scope = await db.rpc('veo_scope', { p_actor: row.data.id });
                        if (scope.error) throw new Error('DatabaseUnavailable');
                        if (!scope.data?.launch_at || !roles.includes(scope.data.role)) return null;
                        return { id: row.data.id, name: row.data.name, email: row.data.email, image: row.data.image };
                    }, 12_000);
                } catch (error) {
                    if (isSupabaseUnavailable(error)) throw new Error('DatabaseUnavailable');
                    throw error;
                }
            }
        })
    ],
    callbacks: {
        async signIn({ account }) {
            return account?.provider === 'credentials';
        },
        async jwt({ token, account, user }) {
            if (account && user) {
                if (account.provider !== 'credentials') return {};
                token.loginStartedAt = Date.now();
                token.id = user.id;
                delete token.facebookId;
                delete token.accessToken;
                delete token.accessTokenExpiresAt;
            }
            if (token.facebookId || token.accessToken) return {};
            return token;
        },
        async session({ session, token }) {
            let workspaceUnavailable = false;
            const scope = workspaceEnabled() && token.id ? await workspaceScope(token.id).catch(() => {
                workspaceUnavailable = true; return null;
            }) : null;
            return { ...session,
                user: { ...session.user, id: workspaceEnabled() && !scope && !workspaceUnavailable ? undefined : token.id, role: scope?.role,
                    workspaceUnavailable,
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
        user: { id?: string; role?: WorkspaceRole; name?: string | null; email?: string | null; image?: string | null; facebookId?: string; telegramUsername?: string | null; telegramProfileCompleted?: boolean; telegramProfileConfirmed?: boolean; workspaceUnavailable?: boolean };
    }
}
declare module 'next-auth/jwt' {
    interface JWT { id?: string; accessToken?: string; accessTokenExpiresAt?: number; facebookId?: string; loginStartedAt?: number }
}
