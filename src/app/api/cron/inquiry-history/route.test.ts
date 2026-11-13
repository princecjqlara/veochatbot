import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ recover: vi.fn() }));
vi.mock('@/lib/veo-inquiry-history', () => ({ recoverFirstInquiries: m.recover }));
import { GET } from './route';
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
it('requires scheduler authentication and an enabled workspace before reading history', async () => {
    vi.stubEnv('CRON_SECRET', 'secret'); vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true');
    expect((await GET(new NextRequest('https://veo.test/api/cron/inquiry-history'))).status).toBe(401);
    expect(m.recover).not.toHaveBeenCalled();
    vi.stubEnv('VEO_WORKSPACE_ENABLED', 'false');
    expect(await (await GET(new NextRequest('https://veo.test/api/cron/inquiry-history', { headers: { Authorization: 'Bearer secret' } }))).json()).toEqual({ skipped: true });
    expect(m.recover).not.toHaveBeenCalled();
});
it('runs bounded metadata recovery and surfaces retryable source errors', async () => {
    vi.stubEnv('CRON_SECRET', 'secret'); vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true');
    const request = () => new NextRequest('https://veo.test/api/cron/inquiry-history', { headers: { Authorization: 'Bearer secret' } });
    m.recover.mockResolvedValueOnce({ checked: 5, changed: 5, failed: 0 });
    expect((await GET(request())).status).toBe(200);
    m.recover.mockResolvedValueOnce({ checked: 0, changed: 0, failed: 1 });
    expect((await GET(request())).status).toBe(503);
});
