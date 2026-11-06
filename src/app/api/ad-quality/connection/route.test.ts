import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), marketing: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/facebook-ad-catalog', () => ({ marketingConnection: m.marketing }));
import { GET } from './route';
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it('makes saved analytics available to email-only sessions without requesting or saving Facebook account credentials', async () => {
    vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true'); m.session.mockResolvedValue({ user: { id: 'owner' } });
    const response = await GET(new NextRequest('https://veo.test/api/ad-quality/connection'));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ status: 'saved_data', accounts: [], readOnlyReports: true });
    expect(m.marketing).not.toHaveBeenCalled(); expect(response.headers.get('Cache-Control')).toBe('no-store');
    m.session.mockResolvedValue(null); expect((await GET(new NextRequest('https://veo.test/api/ad-quality/connection'))).status).toBe(401);
});
