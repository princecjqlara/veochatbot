import { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { createHash } from 'node:crypto';
import { getSupabaseAdmin } from './supabase';
import { passwordMatches, roles, workspaceEnabled, workspaceScope, type WorkspaceRole } from './veo-workspace';

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
            const scope = workspaceEnabled() && token.id ? await workspaceScope(token.id).catch(() => null) : null;
            return { ...session,
                user: { ...session.user, id: workspaceEnabled() && !scope ? undefined : token.id, role: scope?.role,
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
