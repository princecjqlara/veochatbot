import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getConversationForPsid: vi.fn(),
    sendMessage: vi.fn(),
    sendMessengerMediaAttachment: vi.fn(),
    sendMessengerGenericCarousel: vi.fn(),
    generateChatbotFollowUp: vi.fn(),
    recordOutboundMessageEvent: vi.fn()
}));

vi.mock('@/lib/facebook', () => ({
    getConversationForPsid: mocks.getConversationForPsid,
    sendMessage: mocks.sendMessage,
    sendMessengerMediaAttachment: mocks.sendMessengerMediaAttachment,
    sendMessengerGenericCarousel: mocks.sendMessengerGenericCarousel
}));

vi.mock('@/lib/chatbot', () => ({
    generateChatbotFollowUp: mocks.generateChatbotFollowUp,
    getChatbotKnowledgePageId: (config: { page_id: string; knowledge_source_page_id?: string | null }) =>
        config.knowledge_source_page_id || config.page_id
}));

vi.mock('@/lib/outbound-message-events', () => ({
    recordOutboundMessageEvent: mocks.recordOutboundMessageEvent
}));
import {
    getBestTimeFollowUpDueAt,
    getAutomatedFollowUpMessagingType,
    hasReadableCustomerConversationHistory,
    normalizeBestTimeFollowUpDays,
    normalizeQuickFollowUpDelays,
    processDueChatbotFollowUps,
    scheduleChatbotFollowUps
} from '@/lib/chatbot-follow-ups';
import type { ChatbotConfig } from '@/lib/chatbot';

describe('chatbot follow-up scheduling', () => {
    it('requires at least one readable customer message before personalization', () => {
        expect(hasReadableCustomerConversationHistory([], 'page-1')).toBe(false);
        expect(hasReadableCustomerConversationHistory([
            { from: { id: 'page-1' }, message: 'How can we help?' }
        ], 'page-1')).toBe(false);
        expect(hasReadableCustomerConversationHistory([
            { from: { id: 'contact-1' }, message: 'Interested ako sa premium package.' }
        ], 'page-1')).toBe(true);
    });

    it('normalizes aggressive first-day delays and days 2-7', () => {
        expect(normalizeQuickFollowUpDelays([60, 10, 10, 0, 1440, '240']))
            .toEqual([10, 60, 240]);
        expect(normalizeBestTimeFollowUpDays([7, 2, 1, 8, 3, 3]))
            .toEqual([2, 3, 7]);
    });

    it('schedules a later-day send at the contact best Philippine-time hour', () => {
        expect(getBestTimeFollowUpDueAt(
            new Date('2026-09-21T02:00:00.000Z'),
            2,
            9
        )).toBe('2026-09-22T01:00:00.000Z');
    });

    it('uses HUMAN_AGENT only before the guarded seven-day boundary', () => {
        const anchor = '2026-09-21T02:00:00.000Z';
        expect(getAutomatedFollowUpMessagingType(
            'human_agent',
            anchor,
            new Date('2026-09-28T01:58:59.999Z')
        )).toBe('HUMAN_AGENT');
        expect(getAutomatedFollowUpMessagingType(
            'human_agent',
            anchor,
            new Date('2026-09-28T01:59:00.000Z')
        )).toBeNull();
    });

    it('creates quick RESPONSE jobs and direct best-time Human Agent jobs', async () => {
        const inserted: Array<Record<string, unknown>> = [];
        const chain: any = {
            update: vi.fn(() => chain),
            eq: vi.fn(() => chain),
            in: vi.fn(async () => ({ error: null })),
            upsert: vi.fn(async (rows: Array<Record<string, unknown>>) => {
                inserted.push(...rows);
                return { error: null };
            })
        };
        const supabase = { from: vi.fn(() => chain) };
        const config = {
            follow_up_enabled: true,
            follow_up_quick_delays_minutes: [10, 60],
            follow_up_best_time_days: [2, 7],
            follow_up_messages: ['First check-in', 'Second check-in'],
            follow_up_utility_text: 'Update about your request'
        } as ChatbotConfig;

        await expect(scheduleChatbotFollowUps({
            supabase,
            pageId: 'page-1',
            contact: {
                id: 'contact-1',
                page_id: 'page-1',
                psid: 'psid-1',
                best_contact_hour: 9
            },
            config,
            anchorInboundAt: '2026-09-21T02:00:00.000Z',
            now: new Date('2026-09-21T02:00:00.000Z')
        })).resolves.toBe(4);

        expect(inserted.map((job) => job.schedule_type)).toEqual([
            'response', 'response', 'human_agent', 'human_agent'
        ]);
        expect(inserted[0].due_at).toBe('2026-09-21T02:10:00.000Z');
        expect(inserted[2].due_at).toBe('2026-09-22T01:00:00.000Z');
        expect(inserted.every((job) => job.message_text === 'AI-generated from conversation at send time')).toBe(true);
        expect(inserted.some((job) => job.message_text === 'First check-in' || job.message_text === 'Update about your request')).toBe(false);
    });

    it('does not schedule follow-ups after a contact is qualified', async () => {
        const from = vi.fn();
        const config = {
            follow_up_enabled: true,
            follow_up_quick_delays_minutes: [10],
            follow_up_best_time_days: [2],
            follow_up_messages: ['Checking in'],
            follow_up_utility_text: 'Update about your request'
        } as ChatbotConfig;

        await expect(scheduleChatbotFollowUps({
            supabase: { from },
            pageId: 'page-1',
            contact: {
                id: 'contact-1',
                page_id: 'page-1',
                psid: 'psid-1',
                pipeline_stage: 'qualified'
            },
            config,
            anchorInboundAt: '2026-09-21T02:00:00.000Z',
            now: new Date('2026-09-21T02:00:00.000Z')
        })).resolves.toBe(0);

        expect(from).not.toHaveBeenCalled();
    });

    it('sends a due day 2-7 job as ordered split HUMAN_AGENT bubbles', async () => {
        vi.clearAllMocks();
        const conversationHistory = [{
            id: 'message-1',
            message: 'Interested ako sa premium haircut next Friday.',
            from: { id: 'psid-1', name: 'Alex' },
            created_time: '2026-09-21T02:00:00.000Z'
        }];
        mocks.getConversationForPsid.mockResolvedValue({ messages: { data: conversationHistory } });
        mocks.generateChatbotFollowUp.mockResolvedValue({
            message: 'Personalized Human Agent follow-up\n\nWould Friday work?',
            messages: ['Personalized Human Agent follow-up', 'Would Friday work?'],
            personalization_basis: 'Premium haircut next Friday',
            media_document_id: null
        });
        mocks.sendMessage
            .mockResolvedValueOnce({ message_id: 'mid-1' })
            .mockResolvedValueOnce({ message_id: 'mid-2' });
        mocks.recordOutboundMessageEvent.mockResolvedValue(undefined);
        const updates: Array<Record<string, unknown>> = [];
        const dueJob = {
            id: 'job-1',
            page_id: 'page-1',
            contact_id: 'contact-1',
            anchor_inbound_at: '2026-09-21T02:00:00.000Z',
            schedule_type: 'human_agent',
            sequence_index: 0,
            due_at: '2026-09-22T01:00:00.000Z',
            message_text: 'Staff follow-up draft',
            attempt_count: 0
        };
        const supabase = {
            from: vi.fn((table: string) => {
                let operation = '';
                const chain: any = {
                    error: null,
                    update: vi.fn((payload: Record<string, unknown>) => {
                        operation = 'update';
                        updates.push(payload);
                        return chain;
                    }),
                    select: vi.fn(() => {
                        operation = 'select';
                        return chain;
                    }),
                    eq: vi.fn(() => chain),
                    lt: vi.fn(() => chain),
                    lte: vi.fn(() => chain),
                    order: vi.fn(() => chain),
                    limit: vi.fn(async () => table === 'chatbot_follow_up_jobs' && operation === 'select'
                        ? { data: [dueJob], error: null }
                        : { data: [], error: null }),
                    maybeSingle: vi.fn(async () => {
                        if (table === 'chatbot_follow_up_jobs') return { data: { id: dueJob.id, status: 'processing' }, error: null };
                        if (table === 'pages') return { data: { id: 'page-1', name: 'Test Page', fb_page_id: 'fb-page-1', access_token: 'token' }, error: null };
                        if (table === 'contacts') return { data: { id: 'contact-1', page_id: 'page-1', psid: 'psid-1', name: 'Alex', last_interaction_at: dueJob.anchor_inbound_at, last_inbound_at: dueJob.anchor_inbound_at, pipeline_stage: 'engaged' }, error: null };
                        if (table === 'chatbot_configs') return { data: { enabled: true, follow_up_enabled: true }, error: null };
                        return { data: { status: 'active', collected_details: { Service: 'Premium haircut' }, missing_details: ['Mobile number'] }, error: null };
                    })
                };
                return chain;
            })
        };

        const result = await processDueChatbotFollowUps({
            supabase,
            now: new Date('2026-09-22T01:00:00.000Z')
        });

        expect(result).toMatchObject({ checked: 1, sent: 1, readyManual: 0 });
        expect(mocks.sendMessage).toHaveBeenNthCalledWith(
            1,
            'fb-page-1',
            'token',
            'psid-1',
            'Personalized Human Agent follow-up',
            'HUMAN_AGENT'
        );
        expect(mocks.sendMessage).toHaveBeenNthCalledWith(
            2,
            'fb-page-1',
            'token',
            'psid-1',
            'Would Friday work?',
            'HUMAN_AGENT'
        );
        expect(mocks.getConversationForPsid).toHaveBeenCalledWith(
            'fb-page-1',
            'psid-1',
            'token',
            { throwOnError: true, timeoutMs: 5000 }
        );
        expect(mocks.generateChatbotFollowUp).toHaveBeenCalledWith(expect.objectContaining({
            history: conversationHistory,
            collectedDetails: { Service: 'Premium haircut' },
            missingDetails: ['Mobile number']
        }));
        expect(mocks.generateChatbotFollowUp.mock.calls[0][0]).not.toHaveProperty('fallbackMessage');
        expect(mocks.recordOutboundMessageEvent).toHaveBeenCalledWith(
            supabase,
            expect.objectContaining({
                sourceName: 'AI Chatbot day 2-7 follow-up (1/2)',
                messageKind: 'HUMAN_AGENT'
            })
        );
        expect(mocks.recordOutboundMessageEvent).toHaveBeenLastCalledWith(
            supabase,
            expect.objectContaining({
                sourceName: 'AI Chatbot day 2-7 follow-up (2/2)',
                messageKind: 'HUMAN_AGENT'
            })
        );
        expect(updates).toContainEqual(expect.objectContaining({
            status: 'sent',
            message_id: 'mid-2',
            message_text: 'Personalized Human Agent follow-up\n\nWould Friday work?'
        }));
    });
});

describe('follow-up lead-stage checks', () => {
    function fixture(options: { lookupError?: boolean } = {}) {
        const updates: Array<{ table: string; payload: any }> = [];
        const job = { id: 'job-1', page_id: 'page-1', contact_id: 'contact-1',
            anchor_inbound_at: '2026-10-06T00:00:00Z', schedule_type: 'human_agent', sequence_index: 0, attempt_count: 0 };
        let stage = 'engaged';
        let source = 'chatbot';
        let jobStatus = 'processing';
        const supabase = { from: vi.fn((table: string) => {
            const chain: any = {
                select: () => chain, eq: () => chain, in: () => chain, lt: () => chain, lte: () => chain, order: () => chain,
                update: (payload: any) => { updates.push({ table, payload }); return chain; },
                upsert: async (payload: any) => { updates.push({ table, payload }); return { error: null }; },
                limit: async () => ({ data: [job], error: null }),
                maybeSingle: async () => {
                    if (table === 'chatbot_follow_up_jobs') return { data: { id: job.id, status: jobStatus }, error: null };
                    if (table === 'pages') return { data: { id: 'page-1', name: 'Page', fb_page_id: 'fb-page', access_token: 'token' }, error: null };
                    if (table === 'contacts') return { data: { id: 'contact-1', page_id: 'page-1', psid: 'customer', name: 'Customer', last_inbound_at: job.anchor_inbound_at, pipeline_stage: stage, pipeline_stage_source: source }, error: null };
                    if (table === 'chatbot_configs') return { data: { page_id: 'page-1', enabled: true, follow_up_enabled: true }, error: null };
                    return { data: { status: 'active', collected_details: {}, missing_details: [] }, error: options.lookupError ? { message: 'State read failed' } : null };
                },
                then: (resolve: any, reject: any) => Promise.resolve({ data: [], error: null }).then(resolve, reject)
            };
            return chain;
        }) };
        return { supabase, updates, close: () => { stage = 'qualified'; }, handoff: () => { source = 'manual'; }, cancel: () => { jobStatus = 'cancelled'; } };
    }

    it.each(['Qualified', 'Not Qualified', 'Converted', 'Order Created', 'Contacted', 'Intake', 'Custom Stage'])('cancels a due follow-up when Messenger has %s before the poller catches up', async (stage) => {
        vi.clearAllMocks();
        const { supabase, updates } = fixture();
        mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [
            { id: 'lead-1', message: `Lead stage set to ${stage}`, from: { id: 'fb-page' }, created_time: '2026-10-06T02:00:00Z' },
            { message: 'I need a video', from: { id: 'customer' } }
        ] } });
        const result = await processDueChatbotFollowUps({ supabase, now: new Date('2026-10-07T00:00:00Z') });
        expect(result).toMatchObject({ sent: 0, cancelled: 1 });
        expect(mocks.generateChatbotFollowUp).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        const reason = ['Contacted', 'Intake', 'Custom Stage'].includes(stage) ? 'manual' : stage.toLowerCase().replace(/ /g, '_');
        expect(updates).toContainEqual({ table: 'chatbot_contact_states', payload: expect.objectContaining({ status: 'stopped', stop_reason: reason }) });
    });

    it('cancels a Contacted handoff arriving during generation', async () => {
        vi.clearAllMocks();
        const { supabase, handoff } = fixture();
        mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [{ message: 'I need a video', from: { id: 'customer' } }] } });
        mocks.generateChatbotFollowUp.mockImplementation(async () => { handoff(); return { message: 'A follow-up', messages: ['A follow-up'] }; });
        const result = await processDueChatbotFollowUps({ supabase, now: new Date('2026-10-07T00:00:00Z') });
        expect(result).toMatchObject({ sent: 0, cancelled: 1 });
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it('cancels a job handed off while the AI is generating its follow-up', async () => {
        vi.clearAllMocks();
        const { supabase, close } = fixture();
        mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [{ message: 'I need a video', from: { id: 'customer' } }] } });
        mocks.generateChatbotFollowUp.mockImplementation(async () => { close(); return { message: 'A follow-up', messages: ['A follow-up'] }; });
        const result = await processDueChatbotFollowUps({ supabase, now: new Date('2026-10-07T00:00:00Z') });
        expect(result).toMatchObject({ sent: 0, cancelled: 1 });
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it('does not send when a state lookup fails', async () => {
        vi.clearAllMocks();
        const { supabase } = fixture({ lookupError: true });
        const result = await processDueChatbotFollowUps({ supabase, now: new Date('2026-10-07T00:00:00Z') });
        expect(result).toMatchObject({ sent: 0, failed: 1 });
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it('cancels a stage change visible only in Messenger after generation', async () => {
        vi.clearAllMocks();
        const { supabase, updates } = fixture();
        mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [{ message: 'I need a video', from: { id: 'customer' } }] } });
        mocks.generateChatbotFollowUp.mockImplementationOnce(async () => {
            mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [{ message: 'Lead stage set to Qualified', from: { id: 'fb-page' } }] } });
            return { message: 'Follow-up', messages: ['Follow-up'] };
        });
        const result = await processDueChatbotFollowUps({ supabase, now: new Date('2026-10-07T00:00:00Z') });
        expect(result).toMatchObject({ sent: 0, cancelled: 1 });
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(updates).toContainEqual({ table: 'chatbot_contact_states', payload: expect.objectContaining({ status: 'stopped', stop_reason: 'qualified' }) });
    });

    it('cancels remaining follow-up bubbles if the stage changes after one send', async () => {
        vi.clearAllMocks();
        const { supabase, close } = fixture();
        mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [{ message: 'I need a video', from: { id: 'customer' } }] } });
        mocks.generateChatbotFollowUp.mockResolvedValue({ message: 'First\n\nSecond', messages: ['First', 'Second'] });
        mocks.sendMessage.mockImplementationOnce(async () => { close(); return { message_id: 'sent-first' }; });
        const result = await processDueChatbotFollowUps({ supabase, now: new Date('2026-10-07T00:00:00Z') });
        expect(result).toMatchObject({ sent: 0, cancelled: 1 });
        expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('does not retry a partially delivered follow-up after a later send fails', async () => {
        vi.clearAllMocks();
        const { supabase, updates } = fixture();
        mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [{ message: 'I need a video', from: { id: 'customer' } }] } });
        mocks.generateChatbotFollowUp.mockResolvedValue({ message: 'First\n\nSecond', messages: ['First', 'Second'] });
        mocks.sendMessage.mockResolvedValueOnce({ message_id: 'sent-first' }).mockRejectedValueOnce(new Error('Delivery failed'));
        const result = await processDueChatbotFollowUps({ supabase, now: new Date('2026-10-07T00:00:00Z') });
        expect(result).toMatchObject({ sent: 0, failed: 1 });
        expect(updates).toContainEqual({ table: 'chatbot_follow_up_jobs', payload: expect.objectContaining({ status: 'failed', message_id: 'sent-first' }) });
    });

    it('honors cancellation of an already claimed follow-up before delivery', async () => {
        vi.clearAllMocks();
        const { supabase, cancel } = fixture();
        mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [{ message: 'I need a video', from: { id: 'customer' } }] } });
        mocks.generateChatbotFollowUp.mockImplementationOnce(async () => { cancel(); return { message: 'Reminder', messages: ['Reminder'] }; });
        const result = await processDueChatbotFollowUps({ supabase, now: new Date('2026-10-07T00:00:00Z') });
        expect(result).toMatchObject({ sent: 0, cancelled: 1 });
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });
});
