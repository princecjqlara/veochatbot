import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSessionFromRequest: vi.fn(),
    getSupabaseAdmin: vi.fn(),
    userHasPageAccess: vi.fn(),
    generateChatbotFollowUp: vi.fn(),
    generateChatbotResponse: vi.fn(),
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

    it('lets the collaborator edit the same Page-level bot configuration', async () => {
        const builder: Record<string, any> = {};
        builder.upsert = vi.fn(() => builder);
        builder.select = vi.fn(() => builder);
        builder.single = vi.fn().mockResolvedValue({ data: savedConfig, error: null });
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
            reply: 'Just checking whether you still need help next week.'
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
