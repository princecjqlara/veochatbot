import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getConversationForPsid: vi.fn() }));
vi.mock('@/lib/facebook', () => ({ getConversationForPsid: mocks.getConversationForPsid }));
import { assertChatbotDeliveryAllowed, assertMessengerAutomationDeliveryAllowed, ChatbotDeliveryStoppedError } from '@/lib/chatbot-delivery';

function fixture(stage = 'engaged', source = 'chatbot', options: { state?: Record<string, any> | null } = {}) {
    const writes: Array<{ table: string; payload: any }> = [];
    const contact = { pipeline_stage: stage, pipeline_stage_source: source, last_inbound_at: null as string | null };
    const config = { enabled: true, follow_up_enabled: true, commercial_video_intake_enabled: Boolean(options.state?.automation_resumed_at), policy_revision: 1 };
    const state = options.state || null;
    const db = { from: (table: string) => {
        const chain: any = { select: () => chain, eq: () => chain, in: () => chain,
            maybeSingle: async () => ({ data: table === 'contacts' ? contact : table === 'chatbot_configs'
                ? config : table === 'chatbot_contact_states' ? state : null, error: null }),
            upsert: async (payload: any) => { writes.push({ table, payload }); return { error: null }; },
            update: (payload: any) => { writes.push({ table, payload }); return chain; },
            then: (resolve: any) => Promise.resolve({ error: null }).then(resolve)
        };
        return chain;
    } };
    return { contact, writes, config, state, input: { supabase: db, pageId: 'page', facebookPageId: 'fb-page',
        accessToken: 'token', contactId: 'contact', psid: 'customer' } };
}

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('terminal delivery stops', () => {
    it.each(['not_qualified', 'converted'])('blocks non-AI automation for saved %s stages', async stage => {
        await expect(assertMessengerAutomationDeliveryAllowed(fixture(stage).input))
            .rejects.toBeInstanceOf(ChatbotDeliveryStoppedError);
        expect(mocks.getConversationForPsid).not.toHaveBeenCalled();
    });

    it.each(['Not Qualified', 'Converted'])('persists a live %s stop before non-AI delivery', async stage => {
        const { input, writes } = fixture();
        mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [{
            message: `Lead stage set to ${stage}`, from: { id: 'fb-page' }
        }] } });
        await expect(assertMessengerAutomationDeliveryAllowed(input)).rejects.toBeInstanceOf(ChatbotDeliveryStoppedError);
        expect(writes).toContainEqual({ table: 'chatbot_contact_states', payload: expect.objectContaining({
            status: 'stopped', stop_reason: stage === 'Converted' ? 'converted' : 'not_qualified'
        }) });
        expect(writes).toContainEqual({ table: 'chatbot_follow_up_jobs', payload: expect.objectContaining({ status: 'cancelled' }) });
    });

    it('allows independent workflows without requiring an enabled AI chatbot', async () => {
        const { input } = fixture();
        const from = input.supabase.from;
        input.supabase.from = table => {
            if (table === 'chatbot_configs') throw new Error('Independent workflows do not require chatbot settings');
            return from(table);
        };
        mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [] } });
        await expect(assertMessengerAutomationDeliveryAllowed(input)).resolves.toBeUndefined();
    });

    it.each(['qualified', 'converted', 'not_qualified', 'order_created', 'opted_out'])(
        'blocks %s without a photo or source exception', async stage => {
            const { input } = fixture(stage);
            await expect(assertChatbotDeliveryAllowed(input)).rejects.toBeInstanceOf(ChatbotDeliveryStoppedError);
            expect(mocks.getConversationForPsid).not.toHaveBeenCalled();
        }
    );

    it('blocks delivery when a conversation cannot be verified', async () => {
        mocks.getConversationForPsid.mockResolvedValue(null);
        await expect(assertChatbotDeliveryAllowed(fixture().input)).rejects.toThrow('history is unavailable');
    });

    it('honors a stop arriving while an unavailable conversation read is in flight', async () => {
        const { input, contact } = fixture();
        mocks.getConversationForPsid.mockImplementation(async () => { contact.pipeline_stage = 'qualified'; return null; });
        await expect(assertChatbotDeliveryAllowed(input)).rejects.toBeInstanceOf(ChatbotDeliveryStoppedError);
    });

    it('finds and persists a terminal stage outside the first page at delivery time', async () => {
        const { input, writes } = fixture();
        mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [{ message: 'Thanks', from: { id: 'customer' } }],
            paging: { next: 'https://graph.facebook.com/thread/messages?after=older' } } });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{
            message: 'Lead stage set to Converted', from: { id: 'fb-page' }
        }] }) }));
        await expect(assertChatbotDeliveryAllowed(input)).rejects.toBeInstanceOf(ChatbotDeliveryStoppedError);
        expect(writes).toContainEqual({ table: 'chatbot_contact_states', payload: expect.objectContaining({ status: 'stopped', stop_reason: 'converted' }) });
        expect(writes).toContainEqual({ table: 'chatbot_follow_up_jobs', payload: expect.objectContaining({ status: 'cancelled' }) });
    });

    it('blocks a staff mobile handoff appearing during generation without a stage message', async () => {
        const { input, writes } = fixture();
        mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [{
            id: 'staff-reply', from: { id: 'fb-page' }, tags: { data: [{ name: 'source:mobile' }] }
        }] } });
        await expect(assertChatbotDeliveryAllowed(input)).rejects.toBeInstanceOf(ChatbotDeliveryStoppedError);
        expect(writes).toContainEqual({ table: 'chatbot_contact_states', payload: expect.objectContaining({ status: 'stopped', stop_reason: 'manual' }) });
        expect(writes).toContainEqual({ table: 'chatbot_follow_up_jobs', payload: expect.objectContaining({ status: 'cancelled' }) });
    });

    it('continues normal automation when history contains only our API web replies', async () => {
        mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [{
            id: 'bot-reply', message: 'How can we help?', from: { id: 'fb-page' }, tags: { data: [{ name: 'source:web' }] }
        }] } });
        await expect(assertChatbotDeliveryAllowed(fixture().input)).resolves.toBeUndefined();
    });

    it('allows recovery anchored to the exact original webhook millisecond', async () => {
        const { input, contact } = fixture();
        contact.last_inbound_at = '2026-10-17T19:01:47.825Z';
        mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [] } });
        await expect(assertChatbotDeliveryAllowed({ ...input, anchorInboundAt: contact.last_inbound_at }))
            .resolves.toBeUndefined();
    });

    it('still cancels an older reply when a new inbound arrives in the same second', async () => {
        const { input, contact } = fixture();
        contact.last_inbound_at = '2026-10-17T19:01:47.826Z';
        await expect(assertChatbotDeliveryAllowed({ ...input, anchorInboundAt: '2026-10-17T19:01:47.825Z' }))
            .rejects.toBeInstanceOf(ChatbotDeliveryStoppedError);
        expect(mocks.getConversationForPsid).not.toHaveBeenCalled();
    });

    it('honors an owner disabling the Page while history is being read', async () => {
        const { input, config } = fixture();
        mocks.getConversationForPsid.mockImplementationOnce(async () => {
            config.enabled = false;
            return { messages: { data: [] } };
        });
        await expect(assertChatbotDeliveryAllowed(input)).rejects.toBeInstanceOf(ChatbotDeliveryStoppedError);
    });

    const resumedState = () => ({ status: 'active', started_at: '2026-10-17T09:00:00Z',
        automation_resumed_at: '2026-10-17T15:59:00Z', automation_epoch: 2,
        collected_details: {}, missing_details: ['Contact Number'] });

    it('allows staff activity before the reviewed resume boundary', async () => {
        mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [{
            id: 'old-staff', message: 'I will help you', created_time: '2026-10-17T10:00:00Z',
            from: { id: 'fb-page' }, tags: { data: [{ name: 'source:mobile' }] }
        }] } });
        const { input } = fixture('engaged', 'chatbot', { state: resumedState() });
        await expect(assertChatbotDeliveryAllowed({ ...input, automationEpoch: 2, policyRevision: 1 })).resolves.toBeUndefined();
    });

    it('stops new staff activity after the reviewed resume boundary', async () => {
        mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [{
            id: 'new-staff', message: 'I will take over again', created_time: '2026-10-17T16:00:00Z',
            from: { id: 'fb-page' }, tags: { data: [{ name: 'source:mobile' }] }
        }] } });
        const { input, writes } = fixture('engaged', 'chatbot', { state: resumedState() });
        await expect(assertChatbotDeliveryAllowed({ ...input, automationEpoch: 2 })).rejects.toBeInstanceOf(ChatbotDeliveryStoppedError);
        expect(writes).toContainEqual({ table: 'chatbot_contact_states', payload: expect.objectContaining({ status: 'stopped', stop_reason: 'manual', pause_kind: 'human_takeover' }) });
    });

    it('cancels a stale automation epoch before reading history or sending', async () => {
        const { input } = fixture('engaged', 'chatbot', { state: resumedState() });
        await expect(assertChatbotDeliveryAllowed({ ...input, automationEpoch: 1 })).rejects.toBeInstanceOf(ChatbotDeliveryStoppedError);
        expect(mocks.getConversationForPsid).not.toHaveBeenCalled();
    });

    it('cancels generation that used an older policy revision', async () => {
        const { input, config } = fixture('engaged', 'chatbot', { state: resumedState() });
        config.policy_revision = 2;
        await expect(assertChatbotDeliveryAllowed({ ...input, policyRevision: 1 })).rejects.toBeInstanceOf(ChatbotDeliveryStoppedError);
        expect(mocks.getConversationForPsid).not.toHaveBeenCalled();
    });

    it('rechecks policy and automation epochs after a live history request', async () => {
        for (const changed of ['policy', 'epoch']) {
            const { input, config, state } = fixture('engaged', 'chatbot', { state: resumedState() });
            mocks.getConversationForPsid.mockImplementationOnce(async () => {
                if (changed === 'policy') config.policy_revision = 2;
                else state!.automation_epoch = 3;
                return { messages: { data: [] } };
            });
            await expect(assertChatbotDeliveryAllowed({ ...input, automationEpoch: 2, policyRevision: 1 })).rejects.toBeInstanceOf(ChatbotDeliveryStoppedError);
        }
    });
});

it('allows an explicitly reset chat past old stages but honors new stages', async () => {
    const state = { page_id: 'page-1', contact_id: 'contact-1', status: 'active',
        messenger_history_reset_at: '2026-10-17T07:00:00Z', started_at: '2026-10-17T07:00:00Z' };
    const { input } = fixture('engaged', 'system', { state });
    const stage = { id: 'old-stage', message: 'Lead stage set to Not qualified', from: { id: 'fb-page' },
        created_time: '2025-09-15T19:37:44Z' };
    mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [stage] } });
    await expect(assertChatbotDeliveryAllowed(input)).resolves.toBeUndefined();
    mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [{ ...stage, created_time: '2026-10-17T07:01:00Z' }] } });
    await expect(assertChatbotDeliveryAllowed(input)).rejects.toBeInstanceOf(ChatbotDeliveryStoppedError);
});
