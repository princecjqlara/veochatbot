import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ rpc: vi.fn(), maybeSingle: vi.fn(), update: vi.fn(), cookie: vi.fn(), matches: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: () => ({ get: m.cookie }) }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({
    rpc: m.rpc,
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: m.maybeSingle }) }), update: () => ({ eq: m.update }) })
}) }));
vi.mock('@/lib/veo-workspace', async () => ({ ...await vi.importActual<any>('@/lib/veo-workspace'), passwordMatches: m.matches }));
import { authOptions } from '@/lib/auth';
import { CJ_OWNER_USER_ID } from '@/config/veo-owner';
const credentials = (authOptions.providers.find(p => p.id === 'credentials') as any).options.authorize;
const facebook = (accountId = 'fb1') => (authOptions.callbacks!.signIn as any)({
    user: { id: 'oauth', email: 'member@any-provider.example', name: 'Member' }, account: { provider: 'facebook', providerAccountId: accountId }
});
beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true');
    m.rpc.mockImplementation(async name => ({ data: name === 'veo_login_attempt' ? true : { role: 'member', page_ids: ['page'], launch_at: '2026-11-05T00:00:00Z' } }));
    m.maybeSingle.mockResolvedValue({ data: { id: 'member', name: 'Member', email: 'member@any-provider.example', password_hash: 'hashed', is_active: true, facebook_id: 'fb1' } });
    m.matches.mockResolvedValue(true); m.cookie.mockReturnValue({ value: 'member' }); m.update.mockResolvedValue({ error: null });
});
afterEach(() => { vi.unstubAllEnvs(); });
describe('stored roles and administrator-created sign-in', () => {
    it('asks for Telegram confirmation after each new sign-in and uses the saved database profile after session refresh', async () => {
        const loginAt = Date.now();
        const jwt = await (authOptions.callbacks!.jwt as any)({ token: {}, account: { provider: 'credentials' }, user: { id: 'member' } });
        expect(jwt.loginStartedAt).toBeGreaterThanOrEqual(loginAt);
        m.rpc.mockResolvedValue({ data: { role: 'member', telegram_username: 'my_name', telegram_profile_completed_at: new Date(loginAt - 10000).toISOString() } });
        const current = () => (authOptions.callbacks!.session as any)({ session: { user: {} }, token: jwt });
        expect((await current()).user).toMatchObject({ telegramUsername: 'my_name', telegramProfileConfirmed: false });
        m.rpc.mockResolvedValue({ data: { role: 'member', telegram_username: 'my_name', telegram_profile_completed_at: new Date(jwt.loginStartedAt + 1000).toISOString() } });
        expect((await current()).user).toMatchObject({ role: 'member', telegramProfileConfirmed: true });
    });
    it('uses the stored role and does not require staff to guess it at sign-in', async () => {
        expect(await credentials({ email: 'member@any-provider.example', password: ' ', role: 'member' })).toMatchObject({ id: 'member' });
        for (const role of ['manager', 'team_leader', 'owner', undefined]) expect(await credentials({ email: 'member@any-provider.example', password: ' ', role })).toMatchObject({ id: 'member' });
    });
    it('fails closed when the rate limit is exhausted and never looks up or creates a user', async () => {
        m.rpc.mockResolvedValue({ data: false });
        expect(await credentials({ email: 'member@any-provider.example', password: 'x', role: 'member' })).toBeNull();
        expect(m.maybeSingle).not.toHaveBeenCalled(); expect(m.update).not.toHaveBeenCalled();
    });
    it('provides credentials only and rejects Facebook even for CJ Owner', async () => {
        expect(authOptions.providers.map(p => p.id)).toEqual(['credentials']);
        m.cookie.mockReturnValue({ value: 'owner' });
        m.maybeSingle.mockResolvedValue({ data: { id: CJ_OWNER_USER_ID, is_active: true, facebook_id: 'fb1' } });
        m.rpc.mockResolvedValue({ data: { role: 'owner', launch_at: '2026-11-05T00:00:00Z' } });
        expect(await facebook()).toBe(false);
        expect(m.maybeSingle).not.toHaveBeenCalled();
        expect(await (authOptions.callbacks!.signIn as any)({ account: { provider: 'credentials' } })).toBe(true);
    });
    it('invalidates all old Facebook sessions and clears Facebook fields when switching to credentials', async () => {
        const jwt = authOptions.callbacks!.jwt as any;
        for (const id of ['member', CJ_OWNER_USER_ID]) {
            expect(await jwt({ token: { id, facebookId: 'fb1' } })).toEqual({});
            expect(await jwt({ token: { id, accessToken: 'old-facebook-token' } })).toEqual({});
        }
        expect(await jwt({ token: {}, account: { provider: 'facebook', providerAccountId: 'fb1' }, user: { id: CJ_OWNER_USER_ID } })).toEqual({});
        const emailToken = await jwt({ token: { facebookId: 'fb1', accessToken: 'old-owner-token' }, account: { provider: 'credentials' }, user: { id: CJ_OWNER_USER_ID } });
        expect(emailToken.id).toBe(CJ_OWNER_USER_ID); expect(emailToken.facebookId).toBeUndefined(); expect(emailToken.accessToken).toBeUndefined();
        expect(await jwt({ token: { id: 'member' } })).toEqual({ id: 'member' });
    });
});
