import { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { getSupabaseAdmin } from './supabase';
import { passwordMatches, workspaceEnabled, workspaceScope, type WorkspaceRole } from './veo-workspace';
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
                        const row = await db.rpc('veo_login_context', { p_email: email });
                        if (row.error) throw new Error(row.error.message === 'TooManyAttempts' ? 'TooManyAttempts' : 'DatabaseUnavailable');
                        if (row.data?.limited === true) throw new Error('TooManyAttempts');
                        if (!row.data?.id || !await passwordMatches(credentials.password!, row.data.password_hash)) return null;
                        if (row.data.suspension) throw new Error('AccountSuspended');
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
            let suspension: { id: string; reason: string; ends_at: string | null } | undefined;
            const scope = workspaceEnabled() && token.id ? await workspaceScope(token.id).catch((error: any) => {
                if (error.code === 'ACCOUNT_SUSPENDED') { suspension = error.suspension;return null; }
                workspaceUnavailable = true; return null;
            }) : null;
            return { ...session,
                user: { ...session.user, id: workspaceEnabled() && !scope && !workspaceUnavailable ? undefined : token.id, role: scope?.role,
                    workspaceUnavailable,
                    suspension,
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
        user: { id?: string; role?: WorkspaceRole; name?: string | null; email?: string | null; image?: string | null; facebookId?: string; telegramUsername?: string | null; telegramProfileCompleted?: boolean; telegramProfileConfirmed?: boolean; workspaceUnavailable?: boolean; suspension?: { id: string; reason: string; ends_at: string | null } };
    }
}
declare module 'next-auth/jwt' {
    interface JWT { id?: string; accessToken?: string; accessTokenExpiresAt?: number; facebookId?: string; loginStartedAt?: number }
}
