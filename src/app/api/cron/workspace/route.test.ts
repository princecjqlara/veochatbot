import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), remove: vi.fn(), events: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ from: m.from, rpc: m.rpc, storage: { from: () => ({ remove: m.remove }) } }) }));
vi.mock('@/lib/veo-events', () => ({ processWorkspaceEvents: m.events }));
vi.mock('@/app/api/facebook/webhook/route', () => ({ POST: vi.fn() }));
import { GET } from './route';
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('private photo cleanup during unrelated worker failures', () => {
    it('deletes expired objects before a salary or event outage can interrupt the cron', async () => {
        vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true'); vi.stubEnv('CRON_SECRET', 'cron');
        const checkpoints: any[] = [];
        m.from.mockImplementation(table => {
            const q: any = {
                select: () => q, is: () => q, or: () => q, lte: () => q,
                limit: async () => ({ data: table === 'veo_submissions' ? [{ id: 'expired', object_path: 'private/photo', status: 'queued' }] : [] }),
                update: (values: any) => { checkpoints.push({ table, values }); return q; },
                eq: async () => ({ error: null })
            };
            return q;
        });
        m.remove.mockResolvedValue({ error: null }); m.rpc.mockResolvedValue({ error: { message: 'Ledger unavailable' } });
        const response = await GET(new NextRequest('https://veo.test/api/cron/workspace', { headers: { Authorization: 'Bearer cron' } }));
        expect(response.status).toBe(503);
        expect(m.remove).toHaveBeenCalledWith(['private/photo']);
        expect(checkpoints).toContainEqual(expect.objectContaining({ table: 'veo_submissions', values: expect.objectContaining({ status: 'expired' }) }));
        expect(m.remove.mock.invocationCallOrder[0]).toBeLessThan(m.rpc.mock.invocationCallOrder[0]);
        expect(m.events).not.toHaveBeenCalled();
    });
});
