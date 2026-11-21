import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), remove: vi.fn(), events: vi.fn(), sync: vi.fn(), budget: vi.fn(), refresh: vi.fn(), sourceJobs: vi.fn(), guard: vi.fn(), photoCleanup: vi.fn() }));
vi.mock('@/lib/veo-delivered-photo-cleanup', () => ({ cleanupDeliveredReceiptPhotos: m.photoCleanup }));
vi.mock('@/lib/veo-storage-health', () => ({ requireStorageForOptionalWork: m.guard }));
vi.mock('@/lib/veo-facebook-check', () => ({ refreshSubmissionFacebook: m.refresh }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ from: m.from, rpc: m.rpc, storage: { from: () => ({ remove: m.remove }) } }) }));
vi.mock('@/lib/veo-events', () => ({ processWorkspaceEvents: m.events }));
vi.mock('@/lib/veo-telegram-sync', () => ({ syncTelegramWorkforce: m.sync }));
vi.mock('@/lib/veo-budget', () => ({ refreshPageBudgets: m.budget }));
vi.mock('@/lib/veo-source-jobs', () => ({ processVeoSourceJobs: m.sourceJobs }));
vi.mock('@/app/api/facebook/webhook/route', () => ({ POST: vi.fn() }));
import { GET } from './route';
beforeEach(() => { m.guard.mockReset().mockResolvedValue({ optional_work_paused: false });m.photoCleanup.mockReset().mockResolvedValue({ removed: 3 }); });
afterEach(() => { vi.unstubAllEnvs();vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('private photo cleanup during unrelated worker failures', () => {
    it.each([false, true])('cleans photos after durable Telegram delivery and retains delivery when cleanup needs retry: %s', async cleanupFails => {
        vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true');vi.stubEnv('CRON_SECRET', 'cron');vi.stubEnv('VEO_JAUCIAN_URL', 'https://jaucian.test');
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, status: 'sent' })));
        m.guard.mockRejectedValue(Error('Database pressure'));if (cleanupFails) m.photoCleanup.mockRejectedValue(Error('Storage unavailable'));
        m.from.mockImplementation(() => { const q: any = { select: () => q, is: () => q, or: () => q, lte: () => q, limit: async () => ({ data: [] }) };return q; });
        m.rpc.mockImplementation(async name => ({ data: name === 'veo_claim_submissions' ? [{ id: 'submission', claim_token: 'lease' }] : true }));
        m.sync.mockResolvedValue({ checked: 8 });
        const response = await GET(new NextRequest('https://veo.test/api/cron/workspace', { headers: { Authorization: 'Bearer cron' } }));
        expect(response.status).toBe(cleanupFails ? 503 : 200);expect(await response.json()).toMatchObject({ photo_cleanup_retry: cleanupFails });
        expect(m.rpc).toHaveBeenCalledWith('veo_finish_submission', { p_id: 'submission', p_claim: 'lease', p_status: 'delivered', p_error: null });
        expect(m.photoCleanup).toHaveBeenCalledWith(expect.anything(), 'submission');
        const finishIndex = m.rpc.mock.calls.findIndex(([name]) => name === 'veo_finish_submission');
        expect(m.rpc.mock.invocationCallOrder[finishIndex]).toBeLessThan(m.photoCleanup.mock.invocationCallOrder[0]);
    });
    it.each(['busy', 'transport'])('still checkpoints due receipt deliveries when auto-approval needs a retry: %s', async failure => {
        vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true');vi.stubEnv('CRON_SECRET', 'cron');
        m.guard.mockRejectedValue(Error('Database pressure'));
        m.from.mockImplementation(() => { const q: any = { select: () => q, is: () => q, or: () => q, lte: () => q, limit: async () => ({ data: [] }) };return q; });
        m.rpc.mockImplementation(async name => {
            if (name === 'veo_auto_approve_pending_team_reviews') {
                if (failure === 'transport') throw Error('Network unavailable');
                return { error: { code: '55P03', message: 'Background capacity busy' } };
            }
            return { data: name === 'veo_claim_submissions' ? [{ id: 'submission', claim_token: 'lease' }]
                : name === 'veo_handoff' ? null : name === 'veo_submission_requirements' ? { blockers: ['page_access_changed'] } : true };
        });
        m.sync.mockResolvedValue({ checked: 8 });
        const response = await GET(new NextRequest('https://veo.test/api/cron/workspace', { headers: { Authorization: 'Bearer cron' } }));
        expect(response.status).toBe(503);expect(await response.json()).toMatchObject({ ok: false, auto_approval_retry: true, submissions: 1 });
        expect(m.rpc).toHaveBeenCalledWith('veo_enqueue_approved_deal_reviews', { p_limit: 20 });
        expect(m.rpc).toHaveBeenCalledWith('veo_finish_submission', { p_id: 'submission', p_claim: 'lease', p_status: 'blocked', p_error: 'Eligibility or page access changed; review and resubmit' });
    });
    it('defers heavy optional work during pressure while keeping eligibility, expiry cleanup and due deliveries running', async () => {
        vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true');vi.stubEnv('CRON_SECRET', 'cron');
        m.guard.mockRejectedValue(Error('Database pressure'));
        m.from.mockImplementation(() => { const q: any = { select: () => q, is: () => q, or: () => q, lte: () => q, limit: async () => ({ data: [] }) };return q; });
        m.rpc.mockImplementation(async name => ({ data: name === 'veo_claim_submissions' ? [{ id: 'submission', claim_token: 'lease' }]
            : name === 'veo_handoff' ? null : name === 'veo_submission_requirements' ? { blockers: ['facebook_stage_unavailable'], contact_id: 'contact', actor_id: 'actor' } : true }));
        m.sync.mockResolvedValue({ checked: 8 });
        const response = await GET(new NextRequest('https://veo.test/api/cron/workspace', { headers: { Authorization: 'Bearer cron' } }));
        expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ optional_work_paused: true, maintenance_retry: true, event_collection_deferred: true, integration: { checked: 8 } });
        expect(m.rpc.mock.calls.map(([name]) => name)).toContain('veo_claim_submissions');
        expect(m.rpc).toHaveBeenCalledWith('veo_finish_submission', { p_id: 'submission', p_claim: 'lease', p_status: 'queued', p_error: 'Facebook source refresh pending; delivery will retry automatically' });
        expect(m.rpc.mock.calls.map(([name]) => name)).not.toContain('veo_maintenance');expect(m.rpc.mock.calls.map(([name]) => name)).not.toContain('veo_operations_maintenance');
        expect(m.sync).toHaveBeenCalledOnce();expect(m.events).not.toHaveBeenCalled();expect(m.sourceJobs).not.toHaveBeenCalled();expect(m.budget).not.toHaveBeenCalled();
    });
    it('keeps due delivery processing and eligibility alive when optional salary maintenance fails', async () => {
        vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true');vi.stubEnv('CRON_SECRET', 'cron');
        m.from.mockImplementation(() => { const q: any = { select: () => q, is: () => q, or: () => q, lte: () => q, limit: async () => ({ data: [] }) };return q; });
        m.rpc.mockImplementation(async name => name === 'veo_maintenance' ? { error: { message: 'Ledger unavailable' } } : { data: name==='veo_claim_submissions'?[]:true });
        m.sync.mockResolvedValue({ checked: 8 });
        const response = await GET(new NextRequest('https://veo.test/api/cron/workspace', { headers: { Authorization: 'Bearer cron' } }));
        expect(response.status).toBe(200);expect(await response.json()).toMatchObject({maintenance_retry:true,optional_work_paused:true});expect(m.sync).toHaveBeenCalledOnce();expect(m.events).not.toHaveBeenCalled();
        expect(m.rpc.mock.calls.map(([name])=>name)).toContain('veo_claim_submissions');expect(m.sourceJobs).not.toHaveBeenCalled();expect(m.budget).not.toHaveBeenCalled();
    });
    it('refreshes Telegram eligibility even when receipt cleanup is unavailable', async () => {
        vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true');vi.stubEnv('CRON_SECRET', 'cron');
        m.rpc.mockResolvedValue({ data: true });
        m.from.mockImplementation(() => { throw Error('Cleanup unavailable'); });m.sync.mockResolvedValue({ checked: 8 });
        const response = await GET(new NextRequest('https://veo.test/api/cron/workspace', { headers: { Authorization: 'Bearer cron' } }));
        expect(response.status).toBe(503);expect(m.sync).toHaveBeenCalledOnce();
    });
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
        m.rpc.mockImplementation(async name => name === 'veo_operations_maintenance' ? { error: { message: 'Planning outage' } } : { data: name === 'veo_claim_submissions' ? [] : true });
        m.sync.mockRejectedValue(new Error('Telegram unavailable')); m.budget.mockRejectedValue(new Error('Budget unavailable')); m.events.mockResolvedValue(5);
        const response = await GET(new NextRequest('https://veo.test/api/cron/workspace', { headers: { Authorization: 'Bearer cron' } }));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ processed: 5, integration: { retry: true }, budget_retry: true, operations_retry: true });
        expect(m.events).toHaveBeenCalled();
    });
    it.each([false, true])('keeps receipt delivery running when maintenance is cooling down or pressure rises between phases: %s', async pressureRises => {
        vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true');vi.stubEnv('CRON_SECRET', 'cron');
        m.from.mockImplementation(() => { const q: any = { select: () => q, is: () => q, or: () => q, lte: () => q, limit: async () => ({ data: [] }) };return q; });
        m.sync.mockResolvedValue({ checked: 8 });m.events.mockResolvedValue(0);m.sourceJobs.mockResolvedValue({});m.budget.mockResolvedValue({});
        if (pressureRises) m.guard.mockResolvedValueOnce({}).mockRejectedValue(Error('Pressure rose'));
        m.rpc.mockImplementation(async name => ({ data: name === 'veo_claim_maintenance_phase' ? pressureRises
            : name === 'veo_claim_submissions' ? [{ id: 'submission', claim_token: 'lease' }]
            : name === 'veo_handoff' ? null : name === 'veo_submission_requirements' ? { blockers: ['page_access_changed'] } : true }));
        const response = await GET(new NextRequest('https://veo.test/api/cron/workspace', { headers: { Authorization: 'Bearer cron' } }));
        expect(response.status).toBe(200);
        expect(m.rpc).toHaveBeenCalledWith('veo_finish_submission', expect.objectContaining({ p_id: 'submission', p_status: 'blocked' }));
        if (pressureRises) {
            expect(m.rpc.mock.calls.map(([name]) => name)).not.toContain('veo_operations_maintenance');
            expect(m.sourceJobs).not.toHaveBeenCalled();expect(m.budget).not.toHaveBeenCalled();
        } else {
            expect(m.rpc.mock.calls.map(([name]) => name)).not.toContain('veo_maintenance');
            expect(await response.json()).toMatchObject({ maintenance_retry: false, operations_retry: false });
        }
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
        m.remove.mockResolvedValue({ error: null });
        // Acquire the worker lease before simulating the unrelated salary outage.
        // Failing every RPC stops at coordination and never exercises cleanup.
        m.rpc.mockImplementation(async name => name === 'veo_maintenance'
            ? { error: { message: 'Ledger unavailable' } }
            : { data: true });
        const response = await GET(new NextRequest('https://veo.test/api/cron/workspace', { headers: { Authorization: 'Bearer cron' } }));
        expect(response.status).toBe(503);
        expect(m.remove).toHaveBeenCalledWith(['private/photo']);
        expect(checkpoints).toContainEqual(expect.objectContaining({ table: 'veo_submissions', values: expect.objectContaining({ status: 'expired' }) }));
        const maintenance = m.rpc.mock.calls.findIndex(([name]) => name === 'veo_maintenance');
        expect(maintenance).toBeGreaterThanOrEqual(0);
        expect(m.remove.mock.invocationCallOrder[0]).toBeLessThan(m.rpc.mock.invocationCallOrder[maintenance]);
        expect(m.events).not.toHaveBeenCalled();
    });
});
