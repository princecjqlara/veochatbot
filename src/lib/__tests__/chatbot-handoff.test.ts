import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ cancelPendingChatbotFollowUps: vi.fn() }));
vi.mock('@/lib/chatbot-follow-ups', () => ({ cancelPendingChatbotFollowUps: mocks.cancelPendingChatbotFollowUps }));
import { stopChatbotForManualReply } from '@/lib/chatbot-handoff';

function fixture(options: { missingContact?: boolean; saveError?: string; stopReason?: string; stageDuringStop?: string } = {}) {
    const writes: Array<{ table: string; payload: any }> = [];
    const contact = { pipeline_stage: 'collecting_details', pipeline_stage_source: 'chatbot' };
    const state = { status: options.stopReason ? 'stopped' : 'active', stop_reason: options.stopReason || null,
        started_at: '2026-10-10T00:00:00Z', collected_details: { Name: 'Customer' }, missing_details: ['Budget'] };
    const db = { from: (table: string) => {
        const chain: any = {
            select: () => chain, eq: () => chain,
            maybeSingle: async () => ({ data: table === 'contacts' ? options.missingContact ? null : contact : state, error: null }),
            upsert: async (payload: any) => {
                writes.push({ table, payload });
                if (options.stageDuringStop) contact.pipeline_stage = options.stageDuringStop;
                return { error: options.saveError ? { message: options.saveError } : null };
            },
            update: (payload: any) => { writes.push({ table, payload }); return chain; },
            then: (resolve: any) => Promise.resolve({ error: null }).then(resolve)
        };
        return chain;
    } };
    mocks.cancelPendingChatbotFollowUps.mockImplementation(async () => {
        expect(writes[0]).toMatchObject({ table: 'chatbot_contact_states', payload: { status: 'stopped' } });
    });
    return { writes, state, input: { supabase: db, pageId: 'page', contactId: 'contact' } };
}
afterEach(() => { vi.clearAllMocks(); });

describe('manual reply handoffs', () => {
    it('persists the stop, cancels follow-ups, and preserves details and stage before delivery', async () => {
        const { input, state, writes } = fixture();
        expect(await stopChatbotForManualReply(input)).toMatchObject(state);
        expect(writes).toContainEqual({ table: 'chatbot_contact_states', payload: expect.objectContaining({
            status: 'stopped', stop_reason: 'manual', collected_details: { Name: 'Customer' }
        }) });
        expect(writes).toContainEqual({ table: 'contacts', payload: expect.objectContaining({
            pipeline_stage: 'collecting_details', pipeline_stage_source: 'manual'
        }) });
    });
    it('retains a durable opt-out when a person replies', async () => {
        const { input, writes } = fixture({ stopReason: 'opt_out' });
        await stopChatbotForManualReply(input);
        expect(writes[0].payload.stop_reason).toBe('opt_out');
    });
    it('keeps a newer lead stage while saving manual ownership during the handoff', async () => {
        const { input, writes } = fixture({ stageDuringStop: 'qualified' });
        await stopChatbotForManualReply(input);
        expect(writes).toContainEqual({ table: 'contacts', payload: expect.objectContaining({
            pipeline_stage: 'qualified', pipeline_stage_source: 'manual'
        }) });
    });
    it('keeps the specific staff-approved follow-up available while cancelling other jobs', async () => {
        const { input } = fixture();
        await stopChatbotForManualReply({ ...input, followUpJobId: 'approved-job' });
        expect(mocks.cancelPendingChatbotFollowUps).toHaveBeenCalledWith(expect.objectContaining({ exceptJobId: 'approved-job' }));
    });
    it('rejects a missing or wrong-Page contact before any write', async () => {
        const { input, writes } = fixture({ missingContact: true });
        await expect(stopChatbotForManualReply(input)).rejects.toThrow('Contact unavailable');
        expect(writes).toEqual([]);
    });
    it('fails before cancellation or delivery when saving the stop fails', async () => {
        const { input } = fixture({ saveError: 'Database unavailable' });
        await expect(stopChatbotForManualReply(input)).rejects.toThrow('Database unavailable');
        expect(mocks.cancelPendingChatbotFollowUps).not.toHaveBeenCalled();
    });
});
