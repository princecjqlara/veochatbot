import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), remove: vi.fn(), events: vi.fn(), sync: vi.fn(), budget: vi.fn(), refresh: vi.fn(), sourceJobs: vi.fn() }));
vi.mock('@/lib/veo-facebook-check', () => ({ refreshSubmissionFacebook: m.refresh }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ from: m.from, rpc: m.rpc, storage: { from: () => ({ remove: m.remove }) } }) }));
vi.mock('@/lib/veo-events', () => ({ processWorkspaceEvents: m.events }));
vi.mock('@/lib/veo-telegram-sync', () => ({ syncTelegramWorkforce: m.sync }));
vi.mock('@/lib/veo-budget', () => ({ refreshPageBudgets: m.budget }));
vi.mock('@/lib/veo-source-jobs', () => ({ processVeoSourceJobs: m.sourceJobs }));
vi.mock('@/app/api/facebook/webhook/route', () => ({ POST: vi.fn() }));
import { GET } from './route';
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('private photo cleanup during unrelated worker failures', () => {
    it('queues source refresh and retries when saved Facebook evidence is temporarily unavailable', async () => {
        vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true'); vi.stubEnv('CRON_SECRET', 'cron');
        m.from.mockImplementation(() => { const q: any = { select: () => q, is: () => q, or: () => q, lte: () => q, limit: async () => ({ data: [] }) }; return q; });
        m.rpc.mockImplementation(async name => ({ data: name === 'veo_claim_submissions' ? [{ id: 'submission', claim_token: 'lease' }] : name === 'veo_handoff' ? null : name === 'veo_submission_requirements' ? { blockers: ['facebook_stage_unavailable'], contact_id: 'contact', actor_id: 'actor' } : true }));
        m.events.mockResolvedValue(0);
        const response = await GET(new NextRequest('https://veo.test/api/cron/workspace', { headers: { Authorization: 'Bearer cron' } }));
        expect(response.status).toBe(200);
        expect(m.rpc).toHaveBeenCalledWith('veo_handoff', { p_submission: 'submission' });
        expect(m.rpc).toHaveBeenCalledWith('veo_request_source_refresh', { p_actor: 'actor', p_contact: 'contact' });
        expect(m.rpc).toHaveBeenCalledWith('veo_finish_submission', { p_id: 'submission', p_claim: 'lease', p_status: 'queued', p_error: 'Facebook source refresh pending; delivery will retry automatically' });
    });
    it('continues new-event collection during Telegram and planning outages and reports retry health', async () => {
        vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true'); vi.stubEnv('CRON_SECRET', 'cron');
        m.from.mockImplementation(() => { const q: any = { select: () => q, is: () => q, or: () => q, lte: () => q, limit: async () => ({ data: [] }) }; return q; });
        m.rpc.mockImplementation(async name => name === 'veo_operations_maintenance' ? { error: { message: 'Planning outage' } } : { data: name === 'veo_claim_submissions' ? [] : {} });
        m.sync.mockRejectedValue(new Error('Telegram unavailable')); m.budget.mockRejectedValue(new Error('Budget unavailable')); m.events.mockResolvedValue(5);
        const response = await GET(new NextRequest('https://veo.test/api/cron/workspace', { headers: { Authorization: 'Bearer cron' } }));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ processed: 5, integration: { retry: true }, budget_retry: true, operations_retry: true });
        expect(m.events).toHaveBeenCalled();
    });
    it('deletes expired objects before a salary or event outage can interrupt the cron', async () => {
        vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true'); vi.stubEnv('CRON_SECRET', 'cron');
        const checkpoints: any[] = [];
        m.from.mockImplementation(table => {
            const q: any = {
                select: () => q, is: () => q, or: () => q, lte: () => q,
                limit: async () => ({ data: table === 'veo_submissions' ? [{ id: 'expired', object_path: 'private/photo', status: 'queued' }] : [] }),
                update: (values: any) => { checkpoints.push({ table, values }); return q; },
                eq: async () => ({ error: null }), in: async () => ({ error: null })
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
