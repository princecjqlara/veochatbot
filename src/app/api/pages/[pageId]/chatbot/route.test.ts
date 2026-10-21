import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSessionFromRequest: vi.fn(),
    getSupabaseAdmin: vi.fn(),
    userHasPageAccess: vi.fn(),
    generateChatbotFollowUp: vi.fn(),
    generateChatbotResponse: vi.fn(),
    extractChatbotContactDetails: vi.fn(),
    analyzeChatbotContinuation: vi.fn(),
    getOpenRouterModelContextLength: vi.fn(),
    getReadyChatbotMediaForDocument: vi.fn(),
    getReadyChatbotMediaForDocuments: vi.fn(),
    createChatbotMediaSignedUrl: vi.fn()
}));

vi.mock('@/lib/get-session', () => ({
    getSessionFromRequest: mocks.getSessionFromRequest
}));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: mocks.getSupabaseAdmin
}));

vi.mock('@/lib/page-access', () => ({
    userHasPageAccess: mocks.userHasPageAccess
}));

vi.mock('@/lib/chatbot', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/lib/chatbot')>();
    return {
        ...original,
        generateChatbotFollowUp: mocks.generateChatbotFollowUp,
        generateChatbotResponse: mocks.generateChatbotResponse,
        extractChatbotContactDetails: mocks.extractChatbotContactDetails,
        analyzeChatbotContinuation: mocks.analyzeChatbotContinuation,
        getOpenRouterModelContextLength: mocks.getOpenRouterModelContextLength
    };
});

vi.mock('@/lib/chatbot-media', () => ({
    getReadyChatbotMediaForDocument: mocks.getReadyChatbotMediaForDocument,
    getReadyChatbotMediaForDocuments: mocks.getReadyChatbotMediaForDocuments,
    createChatbotMediaSignedUrl: mocks.createChatbotMediaSignedUrl
}));

import { GET, POST, PUT } from './route';

const savedConfig = {
    page_id: 'page_1',
    enabled: false,
    instructions: 'Help customers with accurate Page information.',
    fallback_reply: 'A team member will reply shortly.',
    model: 'test/model',
    rag_enabled: true,
    follow_up_prompt: '',
    details_to_collect: [],
    details_completion_percent: 100,
    bot_dos: '',
    bot_donts: '',
    follow_up_enabled: false,
    follow_up_quick_delays_minutes: [],
    follow_up_best_time_days: [],
    follow_up_messages: [],
    follow_up_ai_instructions: 'Write a personal follow-up.',
    follow_up_utility_template_name: 'acct_followup_v1',
    follow_up_utility_template_language: 'en_US',
    follow_up_utility_text: 'Following up on your request',
    follow_up_media_asset_id: null,
    split_messages: true,
    max_message_parts: 0,
    stop_when_details_collected: true,
    stop_on_opt_out: true,
    stop_on_refusal: true,
    stop_on_qualified: true,
    stop_on_not_qualified: true,
    stop_on_converted: true,
    stop_on_order_created: true
};

function selectBuilder(result: { data: unknown; error: unknown }) {
    const builder: Record<string, any> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn(() => builder);
    builder.maybeSingle = vi.fn().mockResolvedValue(result);
    return builder;
}

function updateBuilder(existingPolicies: Array<{ page_id: string; commercial_video_intake_enabled: boolean }> = []) {
    const builder: Record<string, any> = {};
    builder.select = vi.fn(() => builder);
    builder.in = vi.fn().mockResolvedValue({ data: existingPolicies, error: null });
    builder.upsert = vi.fn().mockResolvedValue({ error: null });
    return builder;
}

const requiredDetails = ['Business Name', 'Business Location', 'Goal ng video', 'Contact Number'];
const completeForm = { 'Business Name': 'CJ Cafe', 'Business Location': 'Manila', 'Goal ng video': 'Promote our opening', 'Contact Number': '09171234567' };

function configRequest(body: unknown, method = 'PUT') {
    return new Request('http://localhost/api/pages/page_1/chatbot', { method,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) as NextRequest;
}

describe('chatbot Page-member access', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'collaborator_1' } });
        mocks.userHasPageAccess.mockResolvedValue(true);
        mocks.getOpenRouterModelContextLength.mockResolvedValue(1_048_576);
        mocks.getReadyChatbotMediaForDocuments.mockResolvedValue([]);
    });

    it('lets any user_pages collaborator load the shared bot configuration', async () => {
        const builder = selectBuilder({ data: savedConfig, error: null });
        mocks.getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => builder) });

        const response = await GET(new Request('http://localhost/api/pages/page_1/chatbot') as NextRequest, {
            params: Promise.resolve({ pageId: 'page_1' })
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(expect.objectContaining({ config: savedConfig }));
        expect(mocks.userHasPageAccess).toHaveBeenCalledWith('collaborator_1', 'page_1');
    });

    it('previews an AI intake review without sending or changing any contact', async () => {
        const builder = selectBuilder({ data: savedConfig, error: null });
        const from = vi.fn(() => builder);
        mocks.getSupabaseAdmin.mockReturnValue({ from });
        mocks.analyzeChatbotContinuation.mockResolvedValue({ purchase_status: 'undecided', confidence: 0.9, summary: 'No agreement', customer_evidence: 'How much?' });
        const response = await POST(new Request('http://localhost/api/pages/page_1/chatbot', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'continuation_review', history: [{ role: 'user', content: 'How much?' }] })
        }) as NextRequest, { params: Promise.resolve({ pageId: 'page_1' }) });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(expect.objectContaining({ would_resume: true, no_customer_messages_sent: true }));
        expect(mocks.generateChatbotResponse).not.toHaveBeenCalled();
        expect(from).toHaveBeenCalledTimes(2);
        expect(from).toHaveBeenNthCalledWith(1, 'chatbot_configs');
        expect(from).toHaveBeenNthCalledWith(2, 'pages');
    });

    it('lets the collaborator edit the same Page-level bot configuration', async () => {
        const builder = updateBuilder();
        mocks.getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => builder) });

        const response = await PUT(new Request('http://localhost/api/pages/page_1/chatbot', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(savedConfig)
        }) as NextRequest, {
            params: Promise.resolve({ pageId: 'page_1' })
        });

        expect(response.status).toBe(200);
        expect(builder.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ page_id: 'page_1', instructions: savedConfig.instructions }),
            { onConflict: 'page_id' }
        );
        expect(mocks.userHasPageAccess).toHaveBeenCalledWith('collaborator_1', 'page_1');
    });

    it('enforces the four-field policy without changing knowledge or follow-up switches', async () => {
        const builder = updateBuilder();
        mocks.getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => builder) });
        const response = await PUT(configRequest({ ...savedConfig, commercial_video_intake_enabled: true,
            details_to_collect: ['Optional budget'], details_completion_percent: 1,
            continuation_review_enabled: true, continuation_review_hour: 8, continuation_review_minute: 12,
            stop_when_details_collected: true, rag_enabled: true, follow_up_enabled: true }),
        { params: Promise.resolve({ pageId: 'page_1' }) });
        expect(response.status).toBe(200);
        expect(builder.upsert).toHaveBeenCalledWith(expect.objectContaining({
            commercial_video_intake_enabled: true, details_to_collect: requiredDetails, details_completion_percent: 100,
            continuation_review_hour: 23, continuation_review_minute: 59, stop_when_details_collected: false,
            follow_up_enabled: true, rag_enabled: true
        }), { onConflict: 'page_id' });
    });

    it('shows effective scoped policy settings on load even when stored legacy values conflict', async () => {
        const builder = selectBuilder({ data: { ...savedConfig, commercial_video_intake_enabled: true,
            details_to_collect: ['Budget'], details_completion_percent: 50, continuation_review_hour: 8,
            continuation_review_minute: 0 }, error: null });
        mocks.getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => builder) });
        const response = await GET(new Request('http://localhost/api/pages/page_1/chatbot') as NextRequest,
            { params: Promise.resolve({ pageId: 'page_1' }) });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(expect.objectContaining({ config: expect.objectContaining({
            details_to_collect: requiredDetails, details_completion_percent: 100, continuation_review_hour: 23,
            continuation_review_minute: 59, stop_when_details_collected: false }) }));
    });

    it('preserves existing scoped policies when an older client copies settings to several Pages', async () => {
        const builder = updateBuilder([{ page_id: 'page_1', commercial_video_intake_enabled: true },
            { page_id: 'page_2', commercial_video_intake_enabled: false }]);
        mocks.getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => builder) });
        const response = await PUT(configRequest({ ...savedConfig, apply_to_page_ids: ['page_2'],
            details_to_collect: ['Service needed'], details_completion_percent: 50 }),
        { params: Promise.resolve({ pageId: 'page_1' }) });
        expect(response.status).toBe(200);
        const [payload] = builder.upsert.mock.calls[0];
        expect(payload[0]).toEqual(expect.objectContaining({ details_to_collect: requiredDetails,
            details_completion_percent: 100, continuation_review_hour: 23, continuation_review_minute: 59, stop_when_details_collected: false }));
        expect(payload[1]).toEqual(expect.objectContaining({ details_to_collect: ['Service needed'], details_completion_percent: 50,
            stop_when_details_collected: true }));
        expect(payload[1]).not.toHaveProperty('commercial_video_intake_enabled');
    });

    it('keeps generic Page form settings and minute precision', async () => {
        const builder = updateBuilder();
        mocks.getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => builder) });
        const response = await PUT(configRequest({ ...savedConfig, commercial_video_intake_enabled: false,
            details_to_collect: ['Service needed'], details_completion_percent: 50,
            continuation_review_enabled: true, continuation_review_hour: 20, continuation_review_minute: 30 }),
        { params: Promise.resolve({ pageId: 'page_1' }) });
        expect(response.status).toBe(200);
        expect(builder.upsert).toHaveBeenCalledWith(expect.objectContaining({ details_to_collect: ['Service needed'],
            details_completion_percent: 50, continuation_review_hour: 20, continuation_review_minute: 30,
            stop_when_details_collected: true }), { onConflict: 'page_id' });
    });

    it.each([-1, 60, 10.5, '59'])('rejects invalid review minute %s before writing', async (minute) => {
        const response = await PUT(configRequest({ ...savedConfig, continuation_review_minute: minute }),
            { params: Promise.resolve({ pageId: 'page_1' }) });
        expect(response.status).toBe(400);
        expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    });

    it.each([
        [false, false, true], [false, true, true], [true, false, true], [true, true, false]
    ])('previews the confirmed OR rule: form complete=%s, clear request=%s', async (formComplete, clearRequest, wouldResume) => {
        const builder = selectBuilder({ data: { ...savedConfig, commercial_video_intake_enabled: true,
            continuation_review_enabled: true }, error: null });
        mocks.getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => builder) });
        mocks.extractChatbotContactDetails.mockResolvedValue({ collected_details: formComplete ? completeForm : { 'Business Name': 'CJ Cafe' }, missing_details: [] });
        mocks.analyzeChatbotContinuation.mockResolvedValue({ purchase_status: clearRequest ? 'agreed' : 'unknown',
            has_clear_request: clearRequest, confidence: 0.9, summary: 'Customer intent reviewed', customer_evidence: 'How much?' });
        const response = await POST(configRequest({ mode: 'continuation_review', history: [{ role: 'user', content: 'How much?' }] }, 'POST'),
            { params: Promise.resolve({ pageId: 'page_1' }) });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(expect.objectContaining({ would_resume: wouldResume, no_customer_messages_sent: true,
            policy: expect.objectContaining({ formComplete, clearRequest }) }));
        expect(mocks.extractChatbotContactDetails).toHaveBeenCalled();
        expect(mocks.generateChatbotResponse).not.toHaveBeenCalled();
    });

    it('applies the same scoped rules to draft previews and ignores legacy expanded targets', async () => {
        const builder = selectBuilder({ data: savedConfig, error: null });
        mocks.getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => builder) });
        mocks.generateChatbotResponse.mockResolvedValue({ reply: 'Form', messages: ['Form'], knowledge: [] });
        const response = await POST(configRequest({ message: 'Hello', detail_target_count: 10,
            draft_config: { commercial_video_intake_enabled: true, details_to_collect: ['Budget'], details_completion_percent: 50,
                continuation_review_hour: 10, continuation_review_minute: 0, stop_when_details_collected: true } }, 'POST'),
            { params: Promise.resolve({ pageId: 'page_1' }) });
        expect(response.status).toBe(200);
        expect(mocks.generateChatbotResponse).toHaveBeenCalledWith(expect.objectContaining({ detailTargetCount: undefined,
            config: expect.objectContaining({ commercial_video_intake_enabled: true, details_to_collect: requiredDetails,
                details_completion_percent: 100, continuation_review_enabled: true, continuation_review_hour: 23, continuation_review_minute: 59, stop_when_details_collected: false }) }));
    });

    it('carries test chat history and collected details into the next reply', async () => {
        const configBuilder = selectBuilder({ data: savedConfig, error: null });
        const pageBuilder = selectBuilder({ data: { name: 'Test Page' }, error: null });
        mocks.getSupabaseAdmin.mockReturnValue({
            from: vi.fn((table: string) => table === 'chatbot_configs' ? configBuilder : pageBuilder)
        });
        mocks.generateChatbotResponse.mockResolvedValue({
            reply: 'What date works for you?',
            messages: ['What date works for you?'],
            collected_details: { 'Service needed': 'Haircut' },
            missing_details: ['Preferred date'],
            details_complete: false,
            detected_stop_reason: null,
            knowledge: [],
            token_usage: {
                prompt_tokens: 1200,
                completion_tokens: 40,
                total_tokens: 1240,
                model: '~deepseek/deepseek-flash-latest'
            }
        });

        const response = await POST(new Request('http://localhost/api/pages/page_1/chatbot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'I need it next week',
                contact_name: 'CJ Lara',
                history: [
                    { role: 'user', content: 'I need a haircut' },
                    { role: 'assistant', content: 'When do you need it?' }
                ],
                collected_details: { 'Service needed': 'Haircut' },
                draft_config: {
                    ...savedConfig,
                    page_id: 'another-page',
                    instructions: 'Always reply in natural Taglish.',
                    bot_dos: 'Always offer two options.',
                    follow_up_prompt: 'End with a useful question.'
                }
            })
        }) as NextRequest, { params: Promise.resolve({ pageId: 'page_1' }) });

        expect(response.status).toBe(200);
        expect(await response.clone().json()).toEqual(expect.objectContaining({
            token_usage: expect.objectContaining({
                total_tokens: 1240,
                context_length: 1_048_576,
                remaining_tokens: 1_047_336
            })
        }));
        expect(mocks.generateChatbotResponse).toHaveBeenCalledWith(expect.objectContaining({
            inboundMessage: 'I need it next week',
            contactName: 'CJ Lara',
            collectedDetails: { 'Service needed': 'Haircut' },
            config: expect.objectContaining({
                page_id: 'page_1',
                instructions: 'Always reply in natural Taglish.',
                bot_dos: 'Always offer two options.',
                follow_up_prompt: 'End with a useful question.'
            }),
            history: [
                expect.objectContaining({ message: 'When do you need it?', from: expect.objectContaining({ id: 'test-page' }) }),
                expect.objectContaining({ message: 'I need a haircut', from: expect.objectContaining({ id: 'test-contact' }) })
            ]
        }));
    });

    it('previews a Human Agent follow-up without scheduling or sending it', async () => {
        const configBuilder = selectBuilder({ data: savedConfig, error: null });
        const pageBuilder = selectBuilder({ data: { name: 'Test Page' }, error: null });
        mocks.getSupabaseAdmin.mockReturnValue({
            from: vi.fn((table: string) => table === 'chatbot_configs' ? configBuilder : pageBuilder)
        });
        mocks.generateChatbotFollowUp.mockResolvedValue({
            message: 'Just checking whether you still need help next week.',
            messages: ['We can help next week.', 'What day works best?'],
            knowledge: [],
            retrieval_warning: undefined
        });

        const response = await POST(new Request('http://localhost/api/pages/page_1/chatbot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mode: 'follow_up',
                follow_up_type: 'human_agent',
                sequence_number: 2,
                history: [
                    { role: 'user', content: 'I need a haircut next week' },
                    { role: 'assistant', content: 'What day works best?' }
                ]
            })
        }) as NextRequest, { params: Promise.resolve({ pageId: 'page_1' }) });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(expect.objectContaining({
            mode: 'follow_up',
            follow_up_type: 'human_agent',
            reply: 'Just checking whether you still need help next week.',
            messages: ['We can help next week.', 'What day works best?']
        }));
        expect(mocks.generateChatbotFollowUp).toHaveBeenCalledWith(expect.objectContaining({
            sequenceNumber: 2,
            scheduleLabel: 'best-time day 2-7'
        }));
        expect(mocks.generateChatbotFollowUp.mock.calls[0][0]).not.toHaveProperty('fallbackMessage');
    });

    it('rejects a signed-in user without a user_pages membership', async () => {
        mocks.userHasPageAccess.mockResolvedValue(false);

        const response = await GET(new Request('http://localhost/api/pages/page_1/chatbot') as NextRequest, {
            params: Promise.resolve({ pageId: 'page_1' })
        });

        expect(response.status).toBe(403);
        expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    });
});
