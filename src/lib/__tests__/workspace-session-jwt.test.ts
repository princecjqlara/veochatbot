import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { encode } from 'next-auth/jwt';
const m = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => m }));
import { getSessionFromRequest } from '../get-session';
import { workspaceScope } from '../veo-workspace';
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it('accepts a real NextAuth session cookie and still checks current database access once', async () => {
    const secret = 'test-only-workspace-session-secret';
    vi.stubEnv('NEXTAUTH_SECRET', secret); vi.stubEnv('NEXTAUTH_URL', 'https://veo.test'); vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true');
    const token = await encode({ secret, token: { id: 'member', name: 'Member' }, maxAge: 60 });
    const request = new NextRequest('https://veo.test/api/workspace', { headers: { cookie: '__Secure-next-auth.session-token=' + token } });
    m.rpc.mockResolvedValue({ data: { user_id: 'member', role: 'member', launch_at: '2026-11-05T00:00:00Z' }, error: null });
    expect((await getSessionFromRequest(request))?.user).toMatchObject({ id: 'member', role: 'member' });
    await workspaceScope('member', request); expect(m.rpc).toHaveBeenCalledOnce();
    const tampered = new NextRequest(request.url, { headers: { cookie: '__Secure-next-auth.session-token=invalid' } });
    expect(await getSessionFromRequest(tampered)).toBeNull(); expect(m.rpc).toHaveBeenCalledOnce();
});
