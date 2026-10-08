import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSupabaseAdmin: vi.fn(),
    verifyWebhookSignature: vi.fn(),
    generateVerifyToken: vi.fn(),
    sendMessage: vi.fn(),
    sendMessengerMediaAttachment: vi.fn(),
    sendMessengerGenericCarousel: vi.fn(),
    getUserProfile: vi.fn(),
    getConversationForPsid: vi.fn(),
    analyzeInboundCustomerImages: vi.fn(),
    generateChatbotResponse: vi.fn(),
    extractChatbotContactDetails: vi.fn(),
    handleFollowUpWorkflowContactReply: vi.fn(),
    triggerReplyWorkflowAutomations: vi.fn(),
    stopWorkflowAutomationsFromPageMessage: vi.fn()
}));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: mocks.getSupabaseAdmin
}));

vi.mock('@/lib/facebook', () => ({
    verifyWebhookSignature: mocks.verifyWebhookSignature,
    generateVerifyToken: mocks.generateVerifyToken,
    sendMessage: mocks.sendMessage,
    sendMessengerMediaAttachment: mocks.sendMessengerMediaAttachment,
    sendMessengerGenericCarousel: mocks.sendMessengerGenericCarousel,
    getUserProfile: mocks.getUserProfile,
    getConversationForPsid: mocks.getConversationForPsid
}));

vi.mock('@/lib/placeholders', () => ({
    replaceTemplateVariables: vi.fn((template: string) => template)
}));

vi.mock('@/lib/chatbot-media', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/lib/chatbot-media')>(),
    analyzeInboundCustomerImages: mocks.analyzeInboundCustomerImages
}));

vi.mock('@/lib/chatbot', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/lib/chatbot')>(),
    generateChatbotResponse: mocks.generateChatbotResponse,
    extractChatbotContactDetails: mocks.extractChatbotContactDetails
}));

vi.mock('@/lib/workflow-automations', () => ({
    handleFollowUpWorkflowContactReply: mocks.handleFollowUpWorkflowContactReply,
    triggerReplyWorkflowAutomations: mocks.triggerReplyWorkflowAutomations,
    stopWorkflowAutomationsFromPageMessage: mocks.stopWorkflowAutomationsFromPageMessage
}));

import { GET, POST } from './route';

function createWebhookVerificationRequest(verifyToken: string): NextRequest {
    const nextUrl = new URL('http://localhost:3000/api/facebook/webhook');
    nextUrl.searchParams.set('hub.mode', 'subscribe');
    nextUrl.searchParams.set('hub.verify_token', verifyToken);
    nextUrl.searchParams.set('hub.challenge', 'facebook-challenge');
    return { nextUrl } as unknown as NextRequest;
}

describe('GET /api/facebook/webhook', () => {
    beforeEach(() => {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('FACEBOOK_APP_SECRET', 'app-secret');
        vi.stubEnv('FACEBOOK_CLIENT_ID', '123456789');
        vi.stubEnv('FACEBOOK_WEBHOOK_VERIFY_TOKEN', 'configured-verify-token');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('verifies Meta using the configured environment token', async () => {
        const response = await GET(createWebhookVerificationRequest('configured-verify-token'));

        expect(response.status).toBe(200);
        expect(await response.text()).toBe('facebook-challenge');
    });

    it('rejects the previous hardcoded test token', async () => {
        const response = await GET(createWebhookVerificationRequest('TEST_TOKEN'));

        expect(response.status).toBe(403);
    });

    it('fails clearly when the verify token is missing', async () => {
        vi.stubEnv('FACEBOOK_WEBHOOK_VERIFY_TOKEN', '');
        const response = await GET(createWebhookVerificationRequest('anything'));

        expect(response.status).toBe(500);
    });
});

function createWebhookRequest(payload?: Record<string, unknown>): NextRequest {
    const defaultPayload = {
        object: 'page',
        entry: [
            {
                id: 'fb_page_1',
                messaging: [
                    {
                        sender: { id: 'contact_psid_1' },
                        recipient: { id: 'fb_page_1' },
                        timestamp: 1700000000000,
                        message: { mid: 'mid.1', text: 'hello there' }
                    }
                ]
            }
        ]
    };

    return new Request('http://localhost:3000/api/facebook/webhook', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload ?? defaultPayload)
    }) as unknown as NextRequest;
}

function createSupabaseMock(options?: {
    welcomeConfig?: {
        enabled: boolean;
        message_text: string;
        buttons: Array<{ type: string; text: string; url?: string; payload?: string }>;
    };
    existingContact?: {
        id: string;
        name?: string | null;
        profile_pic?: string | null;
    } | null;
}) {
    const pageSingle = vi.fn().mockResolvedValue({
        data: {
            id: 'page_row_1',
            access_token: 'page_access_token_1'
        },
        error: null
    });
    const pageEq = vi.fn().mockReturnValue({ single: pageSingle });
    const pageSelect = vi.fn().mockReturnValue({ eq: pageEq });

    const existingContactMaybeSingle = vi.fn().mockResolvedValue({
        data: options?.existingContact ?? null,
        error: null
    });
    const existingContactEqPsid = vi.fn().mockReturnValue({ maybeSingle: existingContactMaybeSingle });
    const existingContactEqPage = vi.fn().mockReturnValue({ eq: existingContactEqPsid });
    const contactsSelect = vi.fn().mockReturnValue({ eq: existingContactEqPage });

    const contactsUpsertSingle = vi.fn().mockResolvedValue({
        data: {
            id: 'contact_row_1',
            name: 'Jane Contact'
        },
        error: null
    });
    const contactsUpsertSelect = vi.fn().mockReturnValue({ single: contactsUpsertSingle });
    const contactsUpsert = vi.fn().mockReturnValue({ select: contactsUpsertSelect });

    const contactsUpdateEq = vi.fn().mockResolvedValue({ error: null });
    const contactsUpdate = vi.fn().mockReturnValue({ eq: contactsUpdateEq });

    const welcomeSingle = vi.fn().mockResolvedValue({
        data: options?.welcomeConfig ?? {
            enabled: false,
            message_text: '',
            buttons: []
        },
        error: null
    });
    const welcomeEq = vi.fn().mockReturnValue({ single: welcomeSingle, maybeSingle: welcomeSingle });
    const welcomeSelect = vi.fn().mockReturnValue({ eq: welcomeEq });

    const interactionsInsert = vi.fn().mockResolvedValue({ error: null });
    const interactionsSelectEqFromContact = vi.fn().mockResolvedValue({
        data: [{ hour_of_day: 22 }],
        error: null
    });
    const interactionsSelectEqContact = vi.fn().mockReturnValue({ eq: interactionsSelectEqFromContact });
    const interactionsSelect = vi.fn().mockReturnValue({ eq: interactionsSelectEqContact });

    const from = vi.fn((table: string) => {
        if (table === 'pages') {
            return {
                select: pageSelect
            };
        }

        if (table === 'contacts') {
            return {
                select: contactsSelect,
                upsert: contactsUpsert,
                update: contactsUpdate
            };
        }

        if (table === 'welcome_messages') {
            return {
                select: welcomeSelect
            };
        }

        if (table === 'contact_interactions') {
            return {
                insert: interactionsInsert,
                select: interactionsSelect
            };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

    return {
        from,
        contactsUpsert
    };
}

function createPhotoChatbotSupabaseMock(options: {
    pipelineStage?: string;
    pipelineSource?: string;
    stopReason?: string;
    detailsToCollect?: string[];
    deliveryStage?: string;
    knownContact?: boolean;
} = {}) {
    const pipelineStage = options.pipelineStage || 'engaged';
    const contactStateUpsert = vi.fn().mockResolvedValue({ error: null });
    const replyEventUpdate = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    const welcomeSelect = vi.fn(() => {
        throw new Error('Photo chatbot handling should bypass the welcome lookup');
    });
    const chatbotConfig = {
        page_id: 'page_row_1',
        enabled: true,
        trial_mode_enabled: false,
        trial_contact_id: null,
        instructions: 'Help the customer.',
        fallback_reply: 'A teammate will reply soon.',
        model: 'test-model',
        rag_enabled: false,
        follow_up_prompt: '',
        details_to_collect: options.detailsToCollect || [],
        details_completion_percent: 100,
        bot_dos: '',
        bot_donts: '',
        follow_up_enabled: false,
        follow_up_quick_delays_minutes: [],
        follow_up_best_time_days: [],
        follow_up_messages: [],
        follow_up_ai_instructions: 'Keep it personal.',
        follow_up_utility_template_name: 'acct_followup_v1',
        follow_up_utility_template_language: 'en_US',
        follow_up_utility_text: 'Following up',
        follow_up_media_asset_id: null,
        split_messages: false,
        max_message_parts: 1,
        stop_when_details_collected: false,
        stop_on_opt_out: true,
        stop_on_refusal: true,
        stop_on_qualified: true,
        stop_on_not_qualified: true,
        stop_on_converted: true,
        stop_on_order_created: true
    };

    const from = vi.fn((table: string) => {
        if (table === 'pages') {
            return {
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        single: vi.fn().mockResolvedValue({
                            data: { id: 'page_row_1', name: 'Test Page', access_token: 'page_access_token_1' },
                            error: null
                        })
                    })
                })
            };
        }
        if (table === 'contacts') {
            return {
                select: vi.fn((columns: string) => ({
                    eq: vi.fn().mockReturnValue({
                        eq: vi.fn().mockReturnValue({
                            maybeSingle: vi.fn().mockResolvedValue({
                                data: columns.startsWith('pipeline_stage') ? {
                                    pipeline_stage: options.deliveryStage || pipelineStage,
                                    pipeline_stage_source: options.pipelineSource || 'chatbot'
                                } : options.knownContact ? { id: 'contact_row_1', name: 'Photo Contact', pipeline_stage: pipelineStage } : null,
                                error: null
                            })
                        })
                    })
                })),
                upsert: vi.fn().mockReturnValue({
                    select: vi.fn().mockReturnValue({
                        single: vi.fn().mockResolvedValue({
                            data: {
                                id: 'contact_row_1', name: 'Photo Contact',
                                pipeline_stage: pipelineStage,
                                pipeline_stage_source: options.pipelineSource || 'chatbot'
                            },
                            error: null
                        })
                    })
                }),
                update: vi.fn(() => {
                    const chain: any = { eq: () => chain, then: (resolve: any) => Promise.resolve({ error: null }).then(resolve) };
                    return chain;
                })
            };
        }
        if (table === 'chatbot_configs') {
            return {
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        maybeSingle: vi.fn().mockResolvedValue({ data: chatbotConfig, error: null })
                    })
                })
            };
        }
        if (table === 'chatbot_follow_up_jobs') {
            return {
                update: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        eq: vi.fn().mockReturnValue({
                            in: vi.fn().mockResolvedValue({ error: null })
                        })
                    })
                })
            };
        }
        if (table === 'chatbot_contact_states') {
            return {
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        eq: vi.fn().mockReturnValue({
                            maybeSingle: vi.fn().mockResolvedValue({
                                data: options.stopReason ? {
                                    status: 'stopped', stop_reason: options.stopReason,
                                    collected_details: { address: 'Saved address' },
                                    missing_details: [], started_at: '2026-10-04T09:00:00Z'
                                } : null,
                                error: null
                            })
                        })
                    })
                }),
                update: (payload: unknown) => {
                    contactStateUpsert(payload, { conditionalUpdate: true });
                    const chain: any = { eq: () => chain, then: (resolve: any) => Promise.resolve({ error: null }).then(resolve) };
                    return chain;
                },
                upsert: contactStateUpsert
            };
        }
        if (table === 'chatbot_reply_events') {
            return {
                insert: vi.fn().mockResolvedValue({ error: null }),
                update: replyEventUpdate
            };
        }
        if (table === 'outbound_message_events') {
            return { upsert: vi.fn().mockResolvedValue({ error: null }) };
        }
        if (table === 'contact_interactions') {
            return {
                insert: vi.fn().mockResolvedValue({ error: null }),
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        eq: vi.fn().mockResolvedValue({ data: [{ hour_of_day: 22 }], error: null })
                    })
                })
            };
        }
        if (table === 'welcome_messages') return { select: welcomeSelect };
        throw new Error(`Unexpected table: ${table}`);
    });

    return { from, welcomeSelect, contactStateUpsert, replyEventUpdate };
}

function createCustomerPhotoRequest(text?: string) {
    return createWebhookRequest({
        object: 'page',
        entry: [{
            id: 'fb_page_1',
            messaging: [{
                sender: { id: 'contact_psid_1' },
                recipient: { id: 'fb_page_1' },
                timestamp: 1791108000000,
                message: {
                    mid: 'mid.photo', text,
                    attachments: [{ type: 'image', payload: { url: 'https://cdn.example.test/receipt.jpg' } }]
                }
            }]
        }]
    });
}

function createSupabaseMockWithFirstInteractionColumnFailure() {
    const pageSingle = vi.fn().mockResolvedValue({
        data: {
            id: 'page_row_1',
            access_token: 'page_access_token_1'
        },
        error: null
    });
    const pageEq = vi.fn().mockReturnValue({ single: pageSingle });
    const pageSelect = vi.fn().mockReturnValue({ eq: pageEq });

    const existingContactMaybeSingle = vi.fn().mockResolvedValue({
        data: null,
        error: null
    });
    const existingContactEqPsid = vi.fn().mockReturnValue({ maybeSingle: existingContactMaybeSingle });
    const existingContactEqPage = vi.fn().mockReturnValue({ eq: existingContactEqPsid });
    const contactsSelect = vi.fn().mockReturnValue({ eq: existingContactEqPage });

    const contactsUpsert = vi.fn()
        .mockReturnValueOnce({
            select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                    data: null,
                    error: {
                        message: "Could not find the 'first_interaction_at' column of 'contacts' in the schema cache"
                    }
                })
            })
        })
        .mockReturnValueOnce({
            select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                    data: {
                        id: 'contact_row_2',
                        name: 'Fallback Contact'
                    },
                    error: null
                })
            })
        });

    const contactsUpdateEq = vi.fn().mockResolvedValue({ error: null });
    const contactsUpdate = vi.fn().mockReturnValue({ eq: contactsUpdateEq });

    const welcomeSingle = vi.fn().mockResolvedValue({
        data: {
            enabled: false,
            message_text: '',
            buttons: []
        },
        error: null
    });
    const welcomeEq = vi.fn().mockReturnValue({ single: welcomeSingle, maybeSingle: welcomeSingle });
    const welcomeSelect = vi.fn().mockReturnValue({ eq: welcomeEq });

    const interactionsInsert = vi.fn().mockResolvedValue({ error: null });
    const interactionsSelectEqFromContact = vi.fn().mockResolvedValue({
        data: [{ hour_of_day: 22 }],
        error: null
    });
    const interactionsSelectEqContact = vi.fn().mockReturnValue({ eq: interactionsSelectEqFromContact });
    const interactionsSelect = vi.fn().mockReturnValue({ eq: interactionsSelectEqContact });

    const from = vi.fn((table: string) => {
        if (table === 'pages') {
            return {
                select: pageSelect
            };
        }

        if (table === 'contacts') {
            return {
                select: contactsSelect,
                upsert: contactsUpsert,
                update: contactsUpdate
            };
        }

        if (table === 'welcome_messages') {
            return {
                select: welcomeSelect
            };
        }

        if (table === 'contact_interactions') {
            return {
                insert: interactionsInsert,
                select: interactionsSelect
            };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

    return {
        from,
        contactsUpsert
    };
}

function createSupabaseMockWithGenericUpsertFailure() {
    const pageSingle = vi.fn().mockResolvedValue({
        data: {
            id: 'page_row_1',
            access_token: 'page_access_token_1'
        },
        error: null
    });
    const pageEq = vi.fn().mockReturnValue({ single: pageSingle });
    const pageSelect = vi.fn().mockReturnValue({ eq: pageEq });

    const existingContactMaybeSingle = vi.fn().mockResolvedValue({
        data: null,
        error: null
    });
    const existingContactEqPsid = vi.fn().mockReturnValue({ maybeSingle: existingContactMaybeSingle });
    const existingContactEqPage = vi.fn().mockReturnValue({ eq: existingContactEqPsid });
    const contactsSelect = vi.fn().mockReturnValue({ eq: existingContactEqPage });

    const contactsUpsert = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
                data: null,
                error: {
                    message: 'insert/update failed due to transient database issue'
                }
            })
        })
    });

    const contactsInsert = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
                data: {
                    id: 'contact_row_inserted',
                    name: 'Broken Contact'
                },
                error: null
            })
        })
    });

    const contactsUpdate = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });

    const from = vi.fn((table: string) => {
        if (table === 'pages') {
            return {
                select: pageSelect
            };
        }

        if (table === 'contacts') {
            return {
                select: contactsSelect,
                upsert: contactsUpsert,
                insert: contactsInsert,
                update: contactsUpdate
            };
        }

        if (table === 'welcome_messages') {
            return {
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        single: vi.fn().mockResolvedValue({
                            data: {
                                enabled: false,
                                message_text: '',
                                buttons: []
                            },
                            error: null
                        }),
                        maybeSingle: vi.fn().mockResolvedValue({
                            data: {
                                enabled: false,
                                message_text: '',
                                buttons: []
                            },
                            error: null
                        })
                    })
                })
            };
        }

        if (table === 'contact_interactions') {
            return {
                insert: vi.fn().mockResolvedValue({ error: null }),
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        eq: vi.fn().mockResolvedValue({ data: [], error: null })
                    })
                })
            };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

    return {
        from,
        contactsUpsert,
        contactsInsert
    };
}

describe('POST /api/facebook/webhook', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('NODE_ENV', 'test');
        mocks.handleFollowUpWorkflowContactReply.mockResolvedValue({
            checked: 0,
            scheduled: 0,
            continued: 0,
            reset: 0,
            sent: 0,
            stopped: 0,
            completed: 0,
            skipped: 0,
            errors: 0
        });
        mocks.triggerReplyWorkflowAutomations.mockResolvedValue({
            checked: 0,
            sent: 0,
            stopped: 0,
            skipped: 0,
            errors: 0
        });
        mocks.stopWorkflowAutomationsFromPageMessage.mockResolvedValue({
            checked: 0,
            stopped: 0,
            skipped: 0
        });
        mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [] } });
        mocks.analyzeInboundCustomerImages.mockResolvedValue('A payment receipt showing PHP 150.');
        mocks.generateChatbotResponse.mockResolvedValue({
            reply: 'Thanks, I can see the PHP 150 receipt.',
            messages: ['Thanks, I can see the PHP 150 receipt.'],
            knowledge: [],
            collected_details: {},
            missing_details: [],
            details_complete: false
        });
        mocks.sendMessage.mockResolvedValue({ message_id: 'mid.reply' });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('creates new contacts and enriches profile from Facebook on first inbound message', async () => {
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'Jane Contact',
            profile_pic: 'https://example.com/jane.jpg'
        });

        const response = await POST(createWebhookRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(mocks.getUserProfile).toHaveBeenCalledWith(
            'contact_psid_1',
            'page_access_token_1',
            { timeoutMs: 2500 }
        );

        expect(supabase.contactsUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                page_id: 'page_row_1',
                psid: 'contact_psid_1',
                name: 'Jane Contact',
                profile_pic: 'https://example.com/jane.jpg'
            }),
            {
                onConflict: 'page_id,psid'
            }
        );
    });

    it('refreshes existing contacts that are missing names', async () => {
        const supabase = createSupabaseMock({
            existingContact: {
                id: 'contact_row_1',
                name: null,
                profile_pic: null
            }
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'Recovered Contact Name',
            profile_pic: 'https://example.com/recovered.jpg'
        });

        const response = await POST(createWebhookRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(mocks.getUserProfile).toHaveBeenCalledWith(
            'contact_psid_1',
            'page_access_token_1',
            { timeoutMs: 2500 }
        );

        expect(supabase.contactsUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                page_id: 'page_row_1',
                psid: 'contact_psid_1',
                name: 'Recovered Contact Name',
                profile_pic: 'https://example.com/recovered.jpg'
            }),
            {
                onConflict: 'page_id,psid'
            }
        );
    });

    it('refreshes existing contacts that still have placeholder Unknown Name values', async () => {
        const supabase = createSupabaseMock({
            existingContact: {
                id: 'contact_row_1',
                name: 'Unknown Name',
                profile_pic: null
            }
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'Recovered Contact Name',
            profile_pic: 'https://example.com/recovered.jpg'
        });

        const response = await POST(createWebhookRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(mocks.getUserProfile).toHaveBeenCalledWith(
            'contact_psid_1',
            'page_access_token_1',
            { timeoutMs: 2500 }
        );

        const payload = supabase.contactsUpsert.mock.calls[0][0] as Record<string, unknown>;
        expect(payload.name).toBe('Recovered Contact Name');
        expect(payload.profile_pic).toBe('https://example.com/recovered.jpg');
    });

    it('clears existing Messenger Contact placeholders when no real name is available', async () => {
        const supabase = createSupabaseMock({
            existingContact: {
                id: 'contact_row_1',
                name: 'MESSENGER CONTACT',
                profile_pic: null
            }
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'MESSENGER CONTACT',
            profile_pic: 'https://example.com/recovered.jpg'
        });

        const response = await POST(createWebhookRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);

        const payload = supabase.contactsUpsert.mock.calls[0][0] as Record<string, unknown>;
        expect(payload.name).toBeNull();
        expect(payload.profile_pic).toBe('https://example.com/recovered.jpg');
    });

    it('uses webhook sender names when profile lookup only returns Messenger Contact', async () => {
        const supabase = createSupabaseMock({
            existingContact: {
                id: 'contact_row_1',
                name: null,
                profile_pic: null
            }
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'Messenger Contact',
            profile_pic: 'https://example.com/recovered.jpg'
        });

        const response = await POST(createWebhookRequest({
            object: 'page',
            entry: [
                {
                    id: 'fb_page_1',
                    messaging: [
                        {
                            sender: { id: 'contact_psid_1', name: 'Real Sender Name' },
                            recipient: { id: 'fb_page_1' },
                            timestamp: 1700000000000,
                            message: { mid: 'mid.1', text: 'hello there' }
                        }
                    ]
                }
            ]
        }));

        expect(response.status).toBe(200);
        const payload = supabase.contactsUpsert.mock.calls[0][0] as Record<string, unknown>;
        expect(payload.name).toBe('Real Sender Name');
        expect(payload.profile_pic).toBe('https://example.com/recovered.jpg');
    });

    it('immediately uses the conversation participant name when profile lookup has no usable name', async () => {
        const supabase = createSupabaseMock({
            existingContact: {
                id: 'contact_row_1',
                name: null,
                profile_pic: null
            }
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'Messenger Contact'
        });
        mocks.getConversationForPsid.mockResolvedValue({
            id: 'conversation_1',
            participants: {
                data: [
                    { id: 'fb_page_1', name: 'Business Page' },
                    { id: 'contact_psid_1', name: 'Immediate Real Name' }
                ]
            },
            messages: { data: [] }
        });

        const response = await POST(createWebhookRequest());

        expect(response.status).toBe(200);
        expect(mocks.getConversationForPsid).toHaveBeenCalledWith(
            'fb_page_1',
            'contact_psid_1',
            'page_access_token_1',
            { throwOnError: true, timeoutMs: 2500 }
        );
        const payload = supabase.contactsUpsert.mock.calls[0][0] as Record<string, unknown>;
        expect(payload.name).toBe('Immediate Real Name');
    });

    it('does not persist placeholder UNKNOWN name values from profile fetch', async () => {
        const supabase = createSupabaseMock({
            existingContact: {
                id: 'contact_row_1',
                name: null,
                profile_pic: null
            }
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'UNKNOWN',
            profile_pic: 'https://example.com/recovered.jpg'
        });

        const response = await POST(createWebhookRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);

        const payload = supabase.contactsUpsert.mock.calls[0][0] as Record<string, unknown>;
        expect(payload).not.toHaveProperty('name');
        expect(payload.profile_pic).toBe('https://example.com/recovered.jpg');
    });

    it('constructs contact name from first_name and last_name when combined name is missing', async () => {
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            first_name: 'Maria',
            last_name: 'Santos',
            profile_pic: 'https://example.com/maria.jpg'
        });

        const response = await POST(createWebhookRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(mocks.getUserProfile).toHaveBeenCalledWith(
            'contact_psid_1',
            'page_access_token_1',
            { timeoutMs: 2500 }
        );

        const payload = supabase.contactsUpsert.mock.calls[0][0] as Record<string, unknown>;
        expect(payload.name).toBe('Maria Santos');
    });

    it('retries contact upsert without first_interaction_at when schema is older', async () => {
        const supabase = createSupabaseMockWithFirstInteractionColumnFailure();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'Fallback Contact',
            profile_pic: 'https://example.com/fallback.jpg'
        });

        const response = await POST(createWebhookRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(supabase.contactsUpsert).toHaveBeenCalledTimes(2);

        const firstPayload = supabase.contactsUpsert.mock.calls[0][0] as Record<string, unknown>;
        const secondPayload = supabase.contactsUpsert.mock.calls[1][0] as Record<string, unknown>;

        expect(firstPayload).toHaveProperty('first_interaction_at');
        expect(secondPayload).not.toHaveProperty('first_interaction_at');
    });

    it('falls back to insert for new contact when upsert fails unexpectedly', async () => {
        const supabase = createSupabaseMockWithGenericUpsertFailure();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'Broken Contact',
            profile_pic: 'https://example.com/broken.jpg'
        });

        const response = await POST(createWebhookRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(supabase.contactsUpsert).toHaveBeenCalledTimes(1);
        expect(supabase.contactsInsert).toHaveBeenCalledTimes(1);
    });

    it('ingests inbound standby events so contacts appear without manual sync', async () => {
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'Standby Contact',
            profile_pic: 'https://example.com/standby.jpg'
        });

        const response = await POST(createWebhookRequest({
            object: 'page',
            entry: [
                {
                    id: 'fb_page_1',
                    standby: [
                        {
                            sender: { id: 'contact_psid_1' },
                            recipient: { id: 'fb_page_1' },
                            timestamp: 1700000000000,
                            message: { mid: 'mid.2', text: 'hi from standby' }
                        }
                    ]
                }
            ]
        }));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(mocks.getUserProfile).toHaveBeenCalledWith(
            'contact_psid_1',
            'page_access_token_1',
            { timeoutMs: 2500 }
        );
        expect(supabase.contactsUpsert).toHaveBeenCalledTimes(1);
    });

    it('analyzes and replies to an image-only first message instead of sending only a welcome', async () => {
        const supabase = createPhotoChatbotSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'Photo Contact'
        });
        mocks.getConversationForPsid.mockResolvedValue({
            id: 'conversation_1',
            participants: { data: [{ id: 'contact_psid_1', name: 'Photo Contact' }] },
            messages: {
                data: [{
                    id: 'mid.photo',
                    message: '',
                    from: { id: 'contact_psid_1', name: 'Photo Contact' },
                    created_time: '2026-10-04T10:00:00Z'
                }]
            }
        });

        const response = await POST(createWebhookRequest({
            object: 'page',
            entry: [{
                id: 'fb_page_1',
                messaging: [{
                    sender: { id: 'contact_psid_1' },
                    recipient: { id: 'fb_page_1' },
                    timestamp: 1791108000000,
                    message: {
                        mid: 'mid.photo',
                        attachments: [{
                            type: 'image',
                            payload: { url: 'https://cdn.example.test/receipt.jpg' }
                        }]
                    }
                }]
            }]
        }));

        expect(response.status).toBe(200);
        expect(supabase.welcomeSelect).not.toHaveBeenCalled();
        expect(mocks.analyzeInboundCustomerImages).toHaveBeenCalledWith({
            imageUrls: ['https://cdn.example.test/receipt.jpg'],
            caption: ''
        });
        expect(mocks.generateChatbotResponse).toHaveBeenCalledWith(expect.objectContaining({
            inboundMessage: expect.stringContaining('A payment receipt showing PHP 150.')
        }));
        expect(mocks.sendMessage).toHaveBeenCalledWith(
            'fb_page_1',
            'page_access_token_1',
            'contact_psid_1',
            'Thanks, I can see the PHP 150 receipt.',
            'RESPONSE',
            undefined,
            undefined,
            undefined,
            undefined
        );
    });

    it('keeps an automatically qualified contact stopped after a new photo', async () => {
        const supabase = createPhotoChatbotSupabaseMock({
            pipelineStage: 'qualified', pipelineSource: 'chatbot', stopReason: 'details_collected'
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        const response = await POST(createCustomerPhotoRequest());
        expect(response.status).toBe(200);
        expect(mocks.analyzeInboundCustomerImages).not.toHaveBeenCalled();
        expect(mocks.generateChatbotResponse).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it('saves late customer answers after handoff without replying or restarting the bot', async () => {
        const supabase = createPhotoChatbotSupabaseMock({
            pipelineStage: 'qualified', pipelineSource: 'messenger', stopReason: 'qualified',
            detailsToCollect: ['Deadline']
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.extractChatbotContactDetails.mockResolvedValue({ collected_details: { Deadline: 'Friday' }, missing_details: [] });
        await POST(createCustomerPhotoRequest('Friday please'));
        expect(mocks.extractChatbotContactDetails).toHaveBeenCalledWith(expect.objectContaining({ inboundMessage: 'Friday please' }));
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(supabase.contactStateUpsert).toHaveBeenLastCalledWith(expect.objectContaining({
            status: 'stopped', stop_reason: 'qualified', collected_details: { address: 'Saved address', Deadline: 'Friday' }
        }), expect.anything());
    });

    it('retains verified details even when Messenger rejects reply delivery', async () => {
        const supabase = createPhotoChatbotSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.generateChatbotResponse.mockResolvedValue({
            reply: 'Friday works', messages: ['Friday works'], knowledge: [],
            collected_details: { Deadline: 'Friday' }, missing_details: [], details_complete: false
        });
        mocks.sendMessage.mockRejectedValue(new Error('Messenger unavailable'));
        await POST(createCustomerPhotoRequest('Friday please'));
        expect(supabase.contactStateUpsert).toHaveBeenCalledWith(expect.objectContaining({ collected_details: { Deadline: 'Friday' } }), expect.anything());
    });

    it('cancels delivery when the contact is handed off during generation', async () => {
        const options = { pipelineSource: 'chatbot', deliveryStage: 'engaged' };
        const supabase = createPhotoChatbotSupabaseMock(options);
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.generateChatbotResponse.mockImplementationOnce(async () => {
            options.pipelineSource = 'manual';
            options.deliveryStage = 'qualified';
            return { messages: ['Reply'], collected_details: {}, missing_details: [], details_complete: false };
        });
        await POST(createCustomerPhotoRequest());
        expect(mocks.generateChatbotResponse).toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it('answers an inquiry button and uses its title as the customer message', async () => {
        const supabase = createPhotoChatbotSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        const response = await POST(createWebhookRequest({ object: 'page', entry: [{ id: 'fb_page_1', messaging: [{
            sender: { id: 'contact_psid_1' }, recipient: { id: 'fb_page_1' }, timestamp: Date.now(),
            postback: { title: 'How much is a video?', payload: 'PRICE_INQUIRY' }
        }] }] }));
        expect(response.status).toBe(200);
        expect(mocks.generateChatbotResponse).toHaveBeenCalledWith(expect.objectContaining({ inboundMessage: 'How much is a video?' }));
        expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
        expect(supabase.welcomeSelect).not.toHaveBeenCalled();
    });

    it.each(['qualified', 'converted', 'not_qualified', 'order_created', 'opted_out'])(
        'blocks text, photos and buttons for %s regardless of who set the stage', async stage => {
            for (const source of ['chatbot', 'manual', 'messenger']) {
                mocks.getSupabaseAdmin.mockReturnValue(createPhotoChatbotSupabaseMock({ pipelineStage: stage, pipelineSource: source }));
                expect((await POST(createWebhookRequest())).status).toBe(200);
                expect((await POST(createCustomerPhotoRequest())).status).toBe(200);
                expect((await POST(createWebhookRequest({ object: 'page', entry: [{ id: 'fb_page_1', messaging: [{
                    sender: { id: 'contact_psid_1' }, recipient: { id: 'fb_page_1' }, timestamp: Date.now(),
                    postback: { title: 'Samples please', payload: 'SAMPLES' }
                }] }] }))).status).toBe(200);
            }
            expect(mocks.analyzeInboundCustomerImages).not.toHaveBeenCalled();
            expect(mocks.generateChatbotResponse).not.toHaveBeenCalled();
            expect(mocks.sendMessage).not.toHaveBeenCalled();
        }
    );

    it('requests a safe retry when Messenger returns no conversation for a stop audit', async () => {
        mocks.getSupabaseAdmin.mockReturnValue(createPhotoChatbotSupabaseMock());
        mocks.getConversationForPsid.mockResolvedValue(null);
        expect((await POST(createWebhookRequest())).status).toBe(500);
        expect(mocks.generateChatbotResponse).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it('answers a first text inquiry instead of consuming it with a welcome', async () => {
        const supabase = createPhotoChatbotSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        const response = await POST(createWebhookRequest());
        expect(response.status).toBe(200);
        expect(mocks.generateChatbotResponse).toHaveBeenCalledWith(expect.objectContaining({ inboundMessage: 'hello there' }));
        expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
        expect(supabase.welcomeSelect).not.toHaveBeenCalled();
    });

    it('records a credit failure without sending the fallback or marking the inquiry answered', async () => {
        const supabase = createPhotoChatbotSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.generateChatbotResponse.mockRejectedValueOnce(new Error('Insufficient credits'));
        const response = await POST(createWebhookRequest());
        expect(response.status).toBe(500);
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(mocks.sendMessengerMediaAttachment).not.toHaveBeenCalled();
        expect(supabase.replyEventUpdate).toHaveBeenCalledWith(expect.objectContaining({
            status: 'failed', outbound_message_id: null, error_message: 'Insufficient credits'
        }));
        expect(supabase.contactStateUpsert).not.toHaveBeenCalled();
    });

    it('uses an earlier price quote from the second history page for a repeat inquiry', async () => {
        mocks.getSupabaseAdmin.mockReturnValue(createPhotoChatbotSupabaseMock());
        const next = 'https://graph.facebook.com/v21.0/thread/messages?after=older';
        const quote = { id: 'quote', message: 'The 24-second video is PHP899.', from: { id: 'fb_page_1', name: 'Page' }, created_time: '2026-10-08T09:00:00Z' };
        const current = { id: 'current', message: 'magkano na nga po', from: { id: 'contact_psid_1', name: 'Customer' }, created_time: '2026-10-08T10:00:00Z' };
        mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [current], paging: { next } } });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [quote] }) }));
        const response = await POST(createWebhookRequest());
        expect(response.status).toBe(200);
        expect(mocks.generateChatbotResponse).toHaveBeenCalledWith(expect.objectContaining({ history: [current, quote] }));
    });

    it('cancels a reply when Messenger sets the stage during AI generation', async () => {
        const supabase = createPhotoChatbotSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.generateChatbotResponse.mockImplementationOnce(async () => {
            mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [{
                id: 'stage-new', message: 'Lead stage set to Qualified', from: { id: 'fb_page_1' }
            }] } });
            return { messages: ['A reply'], collected_details: {}, missing_details: [], details_complete: false };
        });
        const response = await POST(createCustomerPhotoRequest());
        expect(response.status).toBe(200);
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(supabase.contactStateUpsert).toHaveBeenCalledWith(expect.objectContaining({ status: 'stopped', stop_reason: 'qualified' }), expect.anything());
    });

    it('stops remaining reply bubbles when Messenger sets the stage after the first bubble', async () => {
        mocks.getSupabaseAdmin.mockReturnValue(createPhotoChatbotSupabaseMock());
        mocks.generateChatbotResponse.mockResolvedValueOnce({ messages: ['First', 'Second'], collected_details: {}, missing_details: [], details_complete: false });
        mocks.sendMessage.mockImplementationOnce(async () => {
            mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [{ message: 'Lead stage set to Converted', from: { id: 'fb_page_1' } }] } });
            return { message_id: 'first-sent' };
        });
        const response = await POST(createCustomerPhotoRequest());
        expect(response.status).toBe(200);
        expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('cancels delivery if a saved stage changes while the last Messenger read is in flight', async () => {
        const options = { deliveryStage: 'engaged', pipelineSource: 'chatbot' };
        mocks.getSupabaseAdmin.mockReturnValue(createPhotoChatbotSupabaseMock(options));
        mocks.generateChatbotResponse.mockImplementationOnce(async () => {
            mocks.getConversationForPsid.mockImplementationOnce(async () => {
                options.deliveryStage = 'qualified';
                options.pipelineSource = 'manual';
                return null;
            });
            return { messages: ['Reply'], collected_details: {}, missing_details: [], details_complete: false };
        });
        const response = await POST(createCustomerPhotoRequest());
        expect(response.status).toBe(200);
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it.each(['Qualified', 'Not Qualified', 'Converted', 'Order Created', 'Contacted', 'Intake', 'Custom Stage'])('saves an immediate stop for a %s stage echo', async stage => {
        const supabase = createPhotoChatbotSupabaseMock({ knownContact: true });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        const response = await POST(createWebhookRequest({ object: 'page', entry: [{ id: 'fb_page_1', messaging: [{
            sender: { id: 'fb_page_1' }, recipient: { id: 'contact_psid_1' }, timestamp: Date.now(),
            message: { mid: 'stage-event', text: `Lead stage set to ${stage}`, is_echo: true }
        }] }] }));
        expect(response.status).toBe(200);
        const reason = ['Contacted', 'Intake', 'Custom Stage'].includes(stage) ? 'manual' : stage.toLowerCase().replace(/ /g, '_');
        expect(supabase.contactStateUpsert).toHaveBeenCalledWith(expect.objectContaining({ status: 'stopped', stop_reason: reason }), expect.anything());
        expect(mocks.generateChatbotResponse).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it.each(['Contacted', 'Intake', 'Custom Stage'])('stops for a %s event read from Messenger history', async stage => {
        const supabase = createPhotoChatbotSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [{
            id: 'human-stage', message: `Lead stage set to ${stage}`, from: { id: 'fb_page_1' }
        }] } });
        const response = await POST(createWebhookRequest());
        expect(response.status).toBe(200);
        expect(supabase.contactStateUpsert).toHaveBeenCalledWith(expect.objectContaining({ status: 'stopped', stop_reason: 'manual' }), expect.anything());
        expect(mocks.generateChatbotResponse).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it.each(['new', 'engaged', 'collecting_details'])('blocks normal and photo replies for a manually selected %s stage', async stage => {
        mocks.getSupabaseAdmin.mockReturnValue(createPhotoChatbotSupabaseMock({ pipelineStage: stage, pipelineSource: 'manual' }));
        expect((await POST(createWebhookRequest())).status).toBe(200);
        expect((await POST(createCustomerPhotoRequest())).status).toBe(200);
        expect(mocks.generateChatbotResponse).not.toHaveBeenCalled();
        expect(mocks.analyzeInboundCustomerImages).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it.each([
        ['manual qualification', 'qualified', 'manual', 'details_collected', undefined],
        ['Messenger qualification', 'qualified', 'messenger', 'details_collected', undefined],
        ['manual handoff', 'engaged', 'chatbot', 'manual', undefined],
        ['opt-out', 'engaged', 'chatbot', 'opt_out', undefined],
        ['refusal', 'engaged', 'chatbot', 'refusal', undefined],
        ['order created', 'order_created', 'chatbot', 'details_collected', undefined],
        ['new opt-out caption', 'qualified', 'chatbot', 'details_collected', 'do not message me']
    ])('keeps the photo reply blocked for %s', async (_label, pipelineStage, pipelineSource, stopReason, caption) => {
        mocks.getSupabaseAdmin.mockReturnValue(createPhotoChatbotSupabaseMock({
            pipelineStage, pipelineSource, stopReason
        }));
        const response = await POST(createCustomerPhotoRequest(caption));
        expect(response.status).toBe(200);
        expect(mocks.analyzeInboundCustomerImages).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it('keeps photo failure context alongside a caption and still replies', async () => {
        mocks.getSupabaseAdmin.mockReturnValue(createPhotoChatbotSupabaseMock());
        mocks.analyzeInboundCustomerImages.mockRejectedValueOnce(new Error('Unreadable image'));
        const response = await POST(createCustomerPhotoRequest('Paid na po'));
        expect(response.status).toBe(200);
        expect(mocks.generateChatbotResponse).toHaveBeenCalledWith(expect.objectContaining({
            inboundMessage: expect.stringContaining('Customer message: Paid na po')
        }));
        expect(mocks.generateChatbotResponse).toHaveBeenCalledWith(expect.objectContaining({
            inboundMessage: expect.stringContaining('Do not claim to have seen their contents')
        }));
        expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('keeps ordinary text stopped after automatic intake completion', async () => {
        mocks.getSupabaseAdmin.mockReturnValue(createPhotoChatbotSupabaseMock({
            pipelineStage: 'qualified', pipelineSource: 'chatbot', stopReason: 'details_collected'
        }));
        mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [{
            id: 'mid.prior', message: 'Your details are saved.', from: { id: 'fb_page_1' }
        }] } });
        const response = await POST(createWebhookRequest());
        expect(response.status).toBe(200);
        expect(mocks.generateChatbotResponse).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it('blocks photos when the live Messenger conversation indicates qualification', async () => {
        mocks.getSupabaseAdmin.mockReturnValue(createPhotoChatbotSupabaseMock({
            pipelineStage: 'qualified', pipelineSource: 'chatbot', stopReason: 'details_collected'
        }));
        mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [{
            id: 'mid.stage', message: 'Lead stage set to Qualified',
            from: { id: 'fb_page_1' }, created_time: '2026-10-04T10:00:00Z'
        }] } });
        const response = await POST(createCustomerPhotoRequest());
        expect(response.status).toBe(200);
        expect(mocks.analyzeInboundCustomerImages).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it('requests webhook retry without replying when the conversation audit fails', async () => {
        mocks.getSupabaseAdmin.mockReturnValue(createPhotoChatbotSupabaseMock({
            pipelineStage: 'qualified', pipelineSource: 'chatbot', stopReason: 'details_collected'
        }));
        mocks.getConversationForPsid.mockRejectedValue(new Error('Conversation unavailable'));
        const response = await POST(createCustomerPhotoRequest());
        expect(response.status).toBe(500);
        expect(mocks.analyzeInboundCustomerImages).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it('sends welcome as RESPONSE with mapped buttons when welcome config has buttons', async () => {
        const supabase = createSupabaseMock({
            welcomeConfig: {
                enabled: true,
                message_text: 'Hi {first_name} handa ka na bang palakasin sales mo this month?',
                buttons: [
                    { type: 'URL', text: 'CLICK HERE!', url: 'https://meet.google.com/peh-jivc-tgx' },
                    { type: 'QUICK_REPLY', text: 'Talk to sales', payload: '' }
                ]
            }
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'Jane Contact',
            profile_pic: 'https://example.com/jane.jpg'
        });

        const response = await POST(createWebhookRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(mocks.sendMessage).toHaveBeenCalledTimes(1);

        const sendArgs = mocks.sendMessage.mock.calls[0];
        expect(sendArgs[0]).toBe('fb_page_1');
        expect(sendArgs[1]).toBe('page_access_token_1');
        expect(sendArgs[2]).toBe('contact_psid_1');
        expect(sendArgs[4]).toBe('RESPONSE');
        expect(sendArgs[8]).toEqual([
            { type: 'URL', text: 'CLICK HERE!', url: 'https://meet.google.com/peh-jivc-tgx' },
            { type: 'POSTBACK', text: 'Talk to sales', payload: 'Talk to sales' }
        ]);
    });

    it('sends text-only welcome as RESPONSE for a new contact', async () => {
        const supabase = createSupabaseMock({
            welcomeConfig: {
                enabled: true,
                message_text: 'Hi {first_name}! Welcome to our page.',
                buttons: []
            }
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'Jane Contact',
            profile_pic: 'https://example.com/jane.jpg'
        });

        const response = await POST(createWebhookRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(mocks.sendMessage).toHaveBeenCalledTimes(1);

        const sendArgs = mocks.sendMessage.mock.calls[0];
        expect(sendArgs[3]).toBe('Hi {first_name}! Welcome to our page.');
        expect(sendArgs[4]).toBe('RESPONSE');
        expect(sendArgs[8]).toBeUndefined();
    });
});
