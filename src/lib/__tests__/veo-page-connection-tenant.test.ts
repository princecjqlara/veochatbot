import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), verify: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => m }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: async () => ({ user: { id: 'other-owner' } }) }));
vi.mock('@/lib/facebook-page-connection', () => ({ verifyFacebookPageConnection: m.verify, facebookWebhookConnectionStatus: vi.fn(), FacebookPageConnectionError: class extends Error {} }));
vi.mock('@/lib/facebook', () => ({ subscribePageToAppWebhook: vi.fn(), getPageTemplates: vi.fn(), createUtilityTemplate: vi.fn(), isFacebookReauthRequired: vi.fn() }));
import { POST } from '@/app/api/facebook/connect/route';
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
describe('Facebook connection tenant ownership', () => {
    it('cannot move an existing Page or its retained clients into another owner’s tenant', async () => {
        vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true');
        m.rpc.mockResolvedValue({ data: { role: 'owner', tenant_id: 'tenant-b' }, error: null });
        const q: any = { select: () => q, eq: () => q, abortSignal: () => q,
            maybeSingle: async () => ({ data: { id: 'page-a', veo_tenant_id: 'tenant-a' }, error: null }) };
        m.from.mockReturnValue(q);
        const r = await POST(new NextRequest('https://veo.test/api/facebook/connect', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fbPageId: '12345', name: 'Page', accessToken: 'test-token' }) }));
        expect(r.status).toBe(403);
        expect(m.verify).not.toHaveBeenCalled();
    });
});
