import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ history: vi.fn(), generate: vi.fn(), send: vi.fn(), outbound: vi.fn(), carousel: vi.fn(), driveFiles: vi.fn() }));
vi.mock('@/lib/facebook', () => ({ getConversationForPsid: mocks.history, sendMessage: mocks.send, sendMessengerGenericCarousel: mocks.carousel }));
vi.mock('@/lib/chatbot-drive-folders', () => ({ getReadyChatbotDriveFilesForDocuments: mocks.driveFiles, getReadyChatbotDriveFolderForDocument: vi.fn() }));
vi.mock('@/lib/chatbot', () => ({ generateChatbotFollowUp: mocks.generate, getChatbotKnowledgePageId: (config: any) => config.page_id }));
vi.mock('@/lib/outbound-message-events', () => ({ recordOutboundMessageEvent: mocks.outbound }));
import { processDueChatbotFollowUps, scheduleChatbotFollowUps } from '@/lib/chatbot-follow-ups';
import type { ChatbotConfig } from '@/lib/chatbot';
import { ChatbotFollowUpRepeatedError } from '@/lib/chatbot-message-copy';
import { videoPreferences } from './fixtures/commercial-video';

const anchor = '2026-10-17T05:00:00Z';
const now = new Date('2026-10-17T05:01:00Z');
const complete = { ...videoPreferences, 'Business Name': 'CJ Bakery', 'Business Location': 'Manila', 'Goal ng video': 'Sell cakes', 'Contact Number': '09171234567' };
function fixture(formComplete = false, clearRequest = false) {
    const job: any = { id: 'job', page_id: 'page', contact_id: 'contact', anchor_inbound_at: anchor,
        schedule_type: 'response', sequence_index: 0, due_at: now.toISOString(), attempt_count: 0,
        purpose: 'nightly_continuation', automation_epoch: 3, policy_revision: 2, status: 'pending' };
    const config: any = { page_id: 'page', enabled: true, commercial_video_intake_enabled: true, follow_up_enabled: true,
        policy_revision: 2, follow_up_quick_delays_minutes: [10, 60], follow_up_best_time_days: [],
        follow_up_ai_instructions: 'Continue the inquiry.', split_messages: false };
    const state: any = { status: 'active', started_at: anchor, automation_resumed_at: anchor, automation_epoch: 3,
        collected_details: formComplete ? complete : { 'Business Name': 'CJ Bakery' }, missing_details: [],
        has_clear_request: clearRequest, request_type: clearRequest ? 'free_script' : null,
        request_evidence: clearRequest ? 'Free script please' : null };
    const contact: any = { id: 'contact', page_id: 'page', psid: 'customer', name: 'CJ', pipeline_stage: 'engaged',
        pipeline_stage_source: 'chatbot', last_inbound_at: anchor };
    const inserts: any[] = [], writes: any[] = [], sentJobs: any[] = [], predecessors: any[] = [];
    const db: any = { from: (table: string) => {
        let selected = '';
        const chain: any = {
            select: (columns: string) => { selected = columns; return chain; }, eq: () => chain, not: () => chain, lt: () => chain, lte: () => chain, in: () => chain, order: () => chain,
            limit: async () => ({ data: selected === 'id,message_text,message_id' ? sentJobs : [job], error: null }),
            update: (payload: any) => { writes.push({ table, payload });
                // Lease maintenance is a bulk SQL operation, not this test row's new claim.
                if (table === 'chatbot_follow_up_jobs' && (payload.status !== 'pending' || payload.due_at)) Object.assign(job, payload);
                if (table === 'chatbot_contact_states') Object.assign(state, payload);
                return chain;
            },
            upsert: async (rows: any) => { inserts.push(...(Array.isArray(rows) ? rows : [rows])); return { error: null }; },
            maybeSingle: async () => ({ data: table === 'pages' ? { id: 'page', name: 'Bakery Page', fb_page_id: 'fb-page', access_token: 'test' }
                : table === 'contacts' ? contact : table === 'chatbot_configs' ? config
                    : table === 'chatbot_contact_states' ? state
                        : selected === 'status,sent_at,due_at,message_id' ? predecessors[0] || null : job, error: null }),
            then: (resolve: any, reject: any) => Promise.resolve({ error: null }).then(resolve, reject)
        };
        return chain;
    } };
    return { db, job, config, state, contact, inserts, writes, sentJobs, predecessors };
}
beforeEach(() => {
    vi.clearAllMocks();
    mocks.history.mockResolvedValue({ messages: { data: [{ id: 'inbound', from: { id: 'customer', name: 'CJ' },
        message: 'Interested in a commercial for our bakery', created_time: anchor }] } });
    mocks.generate.mockResolvedValue({ message: 'Ano pong location ng CJ Bakery?', messages: ['Ano pong location ng CJ Bakery?'], knowledge: [] });
    mocks.send.mockResolvedValue({ message_id: 'sent' });
});

describe('pricing package follow-up delivery', () => {
    const offer = { delivery_id: 'pricing-delivery', experiment_id: 'run', assignment_id: 'assignment',
        package_id: 'package-b', package_name: 'Plus', price: 799, message: 'A main video with a poster for {business}.',
        duration_seconds: 24, kind: 'promotion' };
    function pricingFixture() {
        const f = fixture();
        f.db.rpc = vi.fn(async (name: string) => ({ data: name === 'reserve_chatbot_pricing_offer' ? offer
            : ['chatbot_pricing_offer_is_active', 'begin_chatbot_pricing_delivery'].includes(name) ? true : null, error: null }));
        return f;
    }
    it('sends one approved package and records it after Messenger acknowledges delivery', async () => {
        const f = pricingFixture();
        f.sentJobs.push({ id: 'older', message_id: 'old-mid', message_text: 'Walang bayad ang free concept o free script; hiwalay ang paid video production.' });
        const result = await processDueChatbotFollowUps({ supabase: f.db, now });
        expect(result).toMatchObject({ sent: 1, failed: 0 });
        expect(mocks.generate).not.toHaveBeenCalled();
        expect(mocks.send).toHaveBeenCalledTimes(1);
        expect(mocks.send.mock.calls[0][3]).toContain('PHP799');
        expect(mocks.send.mock.calls[0][4]).toBe('RESPONSE');
        expect(f.db.rpc).toHaveBeenCalledWith('finish_chatbot_pricing_delivery', { p_delivery_id: 'pricing-delivery', p_message_id: 'sent' });
        expect(f.db.rpc).not.toHaveBeenCalledWith('release_chatbot_pricing_offer', expect.anything());
    });
    it('releases an unsent offer when the pricing run is paused before delivery', async () => {
        const f = pricingFixture();
        f.db.rpc.mockImplementation(async (name: string) => ({ data: name === 'reserve_chatbot_pricing_offer' ? offer : false }));
        expect(await processDueChatbotFollowUps({ supabase: f.db, now })).toMatchObject({ sent: 0, failed: 1 });
        expect(mocks.send).not.toHaveBeenCalled();
        expect(f.db.rpc).toHaveBeenCalledWith('release_chatbot_pricing_offer', { p_delivery_id: 'pricing-delivery' });
        expect(f.db.rpc).not.toHaveBeenCalledWith('finish_chatbot_pricing_delivery', expect.anything());
    });
    it('does not use a promotional package with a HUMAN_AGENT follow-up', async () => {
        const f = pricingFixture();
        f.job.schedule_type = 'human_agent';
        await processDueChatbotFollowUps({ supabase: f.db, now });
        expect(f.db.rpc).not.toHaveBeenCalledWith('reserve_chatbot_pricing_offer', expect.anything());
        expect(f.db.rpc).toHaveBeenCalledWith('get_chatbot_pricing_contact_catalog', { p_page_id: 'page', p_contact_id: 'contact' });
        expect(mocks.generate).toHaveBeenCalledTimes(1);
    });
    it('does not reserve or send a promotional offer after the response window', async () => {
        const f = pricingFixture();
        const result = await processDueChatbotFollowUps({ supabase: f.db, now: new Date('2026-10-18T05:01:00Z') });
        expect(result).toMatchObject({ sent: 0, cancelled: 1 });
        expect(f.db.rpc).not.toHaveBeenCalled();
        expect(mocks.send).not.toHaveBeenCalled();
    });
    it('retains an acknowledged offer if exposure recording fails, preventing an automatic replay', async () => {
        const f = pricingFixture();
        f.db.rpc.mockImplementation(async (name: string) => name === 'finish_chatbot_pricing_delivery'
            ? { error: { message: 'Temporary database error' } } : { data: name === 'reserve_chatbot_pricing_offer' ? offer : true });
        expect(await processDueChatbotFollowUps({ supabase: f.db, now })).toMatchObject({ sent: 0, failed: 1 });
        expect(mocks.send).toHaveBeenCalledTimes(1);
        expect(f.job).toMatchObject({ status: 'failed', message_id: 'sent' });
        expect(f.db.rpc).not.toHaveBeenCalledWith('release_chatbot_pricing_offer', expect.anything());
    });
    it('retains a network send with an uncertain result for review and does not retry it automatically', async () => {
        const f = pricingFixture();
        mocks.send.mockRejectedValue(new Error('Facebook send timed out'));
        expect(await processDueChatbotFollowUps({ supabase: f.db, now })).toMatchObject({ sent: 0, failed: 1 });
        expect(f.job.status).toBe('failed');
        expect(f.db.rpc).toHaveBeenCalledWith('begin_chatbot_pricing_delivery', { p_delivery_id: 'pricing-delivery' });
        expect(f.db.rpc).not.toHaveBeenCalledWith('release_chatbot_pricing_offer', expect.anything());
    });
    it('does not fall back to AI copy when the same source already sent or has an uncertain receipt', async () => {
        const f = pricingFixture();
        f.db.rpc.mockResolvedValue({ data: { blocked: true } });
        expect(await processDueChatbotFollowUps({ supabase: f.db, now })).toMatchObject({ sent: 0, failed: 1 });
        expect(mocks.generate).not.toHaveBeenCalled();
        expect(mocks.send).not.toHaveBeenCalled();
        expect(f.job.status).toBe('failed');
    });
});

describe('commercial-video follow-up continuity', () => {
    it('uses computed first-day opportunities for a silent new client', async () => {
        const f = fixture();
        f.config.follow_up_first_day_mode = 'adaptive';
        f.contact.first_interaction_at = anchor;
        await scheduleChatbotFollowUps({ supabase: f.db, pageId: 'page', contact: f.contact,
            config: f.config, anchorInboundAt: anchor, now });
        expect(f.inserts).toHaveLength(3);
        expect(f.inserts[0]).toMatchObject({ purpose: 'first_day_adaptive',
            due_at: '2026-10-17T05:45:00.000Z', timing_context: { initial_reply_end: now.toISOString() } });
    });
    it('does not restart the cold first-day sequence after a customer returns', async () => {
        const f = fixture();
        f.config.follow_up_first_day_mode = 'adaptive';
        f.contact.first_interaction_at = '2026-10-17T04:00:00Z';
        expect(await scheduleChatbotFollowUps({ supabase: f.db, pageId: 'page', contact: f.contact,
            config: f.config, anchorInboundAt: anchor, now })).toBe(0);
        expect(f.inserts).toEqual([]);
    });
    it('delivers an eligible adaptive reminder with the ordinary conversation guards', async () => {
        const f = fixture();
        f.config.follow_up_first_day_mode = 'adaptive';
        Object.assign(f.job, { purpose: 'first_day_adaptive', timing_context: { initial_reply_end: anchor } });
        expect(await processDueChatbotFollowUps({ supabase: f.db, now: new Date('2026-10-17T05:45:00Z') }))
            .toMatchObject({ sent: 1, failed: 0 });
    });
    it('moves a delayed overnight reminder to the next waking slot', async () => {
        const f = fixture();
        f.config.follow_up_first_day_mode = 'adaptive';
        Object.assign(f.job, { purpose: 'first_day_adaptive', timing_context: { initial_reply_end: anchor } });
        expect(await processDueChatbotFollowUps({ supabase: f.db, now: new Date('2026-10-17T13:00:00Z') }))
            .toMatchObject({ sent: 0, failed: 0 });
        expect(f.job).toMatchObject({ status: 'pending', due_at: '2026-10-18T00:00:00.000Z' });
        expect(mocks.generate).not.toHaveBeenCalled();
    });
    it('spaces a second reminder from actual delivery instead of its old planned time', async () => {
        const f = fixture();
        f.config.follow_up_first_day_mode = 'adaptive';
        Object.assign(f.job, { purpose: 'first_day_adaptive', sequence_index: 1,
            timing_context: { initial_reply_end: anchor } });
        f.predecessors.push({ status: 'sent', message_id: 'earlier', sent_at: '2026-10-17T06:00:00Z' });
        expect(await processDueChatbotFollowUps({ supabase: f.db, now: new Date('2026-10-17T08:00:00Z') }))
            .toMatchObject({ sent: 0, failed: 0 });
        expect(f.job.due_at).toBe('2026-10-17T09:00:00.000Z');
        expect(mocks.generate).not.toHaveBeenCalled();
    });
    it('honors previously delivered reminders carried into the new timing policy', async () => {
        const f = fixture();
        f.config.follow_up_first_day_mode = 'adaptive';
        Object.assign(f.job, { purpose: 'first_day_adaptive', sequence_index: 1,
            timing_context: { initial_reply_end: anchor, carried_sent_times: ['2026-10-17T06:00:00Z'] } });
        expect(await processDueChatbotFollowUps({ supabase: f.db, now: new Date('2026-10-17T09:00:00Z') }))
            .toMatchObject({ sent: 1, failed: 0 });
    });
    it.each(['failed', 'cancelled'])('ends the sequence after a %s preceding reminder', async status => {
        const f = fixture();
        f.config.follow_up_first_day_mode = 'adaptive';
        Object.assign(f.job, { purpose: 'first_day_adaptive', sequence_index: 1 });
        f.predecessors.push({ status });
        expect(await processDueChatbotFollowUps({ supabase: f.db, now: new Date('2026-10-17T09:00:00Z') }))
            .toMatchObject({ sent: 0, cancelled: 1 });
        expect(mocks.generate).not.toHaveBeenCalled();
    });
    it('cancels adaptive work when its mode changes during generation', async () => {
        const f = fixture();
        f.config.follow_up_first_day_mode = 'adaptive';
        Object.assign(f.job, { purpose: 'first_day_adaptive', timing_context: { initial_reply_end: anchor } });
        mocks.generate.mockImplementationOnce(async () => {
            f.config.follow_up_first_day_mode = 'fixed';
            return { message: 'New copy', messages: ['New copy'] };
        });
        expect(await processDueChatbotFollowUps({ supabase: f.db, now: new Date('2026-10-17T05:45:00Z') }))
            .toMatchObject({ sent: 0, cancelled: 1 });
        expect(mocks.send).not.toHaveBeenCalled();
    });
    it('expires at the original first-day boundary without extending from later sends', async () => {
        const f = fixture();
        f.config.follow_up_first_day_mode = 'adaptive';
        Object.assign(f.job, { purpose: 'first_day_adaptive', timing_context: { initial_reply_end: anchor } });
        expect(await processDueChatbotFollowUps({ supabase: f.db, now: new Date('2026-10-18T04:50:00Z') }))
            .toMatchObject({ sent: 0, cancelled: 1 });
        expect(mocks.generate).not.toHaveBeenCalled();
    });
    it.each([[false, false, 1], [false, true, 1], [true, false, 1], [true, true, 0]])(
        'schedules required continuation for form=%s request=%s', async (form, request, count) => {
            const f = fixture(Boolean(form), Boolean(request));
            const scheduled = await scheduleChatbotFollowUps({ supabase: f.db, pageId: 'page', contact: f.contact,
                config: f.config as ChatbotConfig, anchorInboundAt: anchor, now });
            expect(scheduled > 0).toBe(Boolean(count));
            expect(f.inserts.every(job => job.automation_epoch === 3 && job.policy_revision === 2)).toBe(true);
        });
    it('sends a knowledge-generated continuation after a reviewed resume with partial form and saved request', async () => {
        const f = fixture(false, true);
        expect(await processDueChatbotFollowUps({ supabase: f.db, now })).toMatchObject({ sent: 1, failed: 0 });
        expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ hasClearRequest: true, requestType: 'free_script' }));
        expect(mocks.send).toHaveBeenCalledTimes(1);
    });
    it('sends the existing sample before its final question and checkpoints both text messages', async () => {
        const f = fixture();
        const messages = ['CJ, ito ang existing sample para sa bakery.', 'Ilang seconds ang gusto mo para sa video?'];
        mocks.generate.mockResolvedValueOnce({ messages, message: messages.join('\n\n'), drive_file_document_ids: ['sample-doc'] });
        mocks.driveFiles.mockResolvedValueOnce([{ name: 'Bakery sample', media_type: 'video', web_view_url: 'https://drive.google.com/sample' }]);
        mocks.carousel.mockResolvedValueOnce({ message_id: 'sample-card' });
        expect(await processDueChatbotFollowUps({ supabase: f.db, now })).toMatchObject({ sent: 1, failed: 0, mediaSent: 1 });
        expect(mocks.send.mock.invocationCallOrder[0]).toBeLessThan(mocks.carousel.mock.invocationCallOrder[0]);
        expect(mocks.send.mock.invocationCallOrder[1]).toBeGreaterThan(mocks.carousel.mock.invocationCallOrder[0]);
        expect(f.job.message_text).toBe(messages.join('\n\n'));
    });
    it('checks for staff takeover again before the question following a sample', async () => {
        const f = fixture();
        const messages = ['CJ, ito ang existing sample para sa bakery.', 'Ilang seconds ang gusto mo para sa video?'];
        mocks.generate.mockResolvedValueOnce({ messages, message: messages.join('\n\n'), drive_file_document_ids: ['sample-doc'] });
        mocks.driveFiles.mockResolvedValueOnce([{ name: 'Bakery sample', media_type: 'video', web_view_url: 'https://drive.google.com/sample' }]);
        mocks.carousel.mockImplementationOnce(async () => { f.state.status = 'stopped'; f.state.automation_epoch++; return { message_id: 'sample-card' }; });
        expect(await processDueChatbotFollowUps({ supabase: f.db, now })).toMatchObject({ cancelled: 1, sent: 0 });
        expect(mocks.send).toHaveBeenCalledTimes(1);
        expect(f.job.message_text).toBe(messages[0]);
    });
    it('stops the sequence once both required form and customer request are complete', async () => {
        const f = fixture(true, true);
        expect(await processDueChatbotFollowUps({ supabase: f.db, now })).toMatchObject({ sent: 0, cancelled: 1 });
        expect(mocks.generate).not.toHaveBeenCalled();
        expect(f.state).toMatchObject({ status: 'stopped', pause_kind: 'ready_for_team' });
    });
    it('rejects jobs from before a new staff intervention', async () => {
        const f = fixture(); f.state.automation_epoch = 4;
        expect(await processDueChatbotFollowUps({ supabase: f.db, now })).toMatchObject({ sent: 0, cancelled: 1 });
        expect(mocks.generate).not.toHaveBeenCalled();
    });
    it('does not let an acknowledged historical stage stop a reset contact again', async () => {
        const f = fixture();
        f.state.messenger_history_reset_at = anchor;
        mocks.history.mockResolvedValue({ messages: { data: [
            { id: 'inbound', from: { id: 'customer' }, message: 'Interested in a bakery video', created_time: anchor },
            { id: 'old-stage', from: { id: 'fb-page' }, message: 'Lead stage set to Not qualified', created_time: '2025-09-15T19:37:44Z' }
        ] } });
        expect(await processDueChatbotFollowUps({ supabase: f.db, now })).toMatchObject({ sent: 1, cancelled: 0, failed: 0 });
        expect(f.state.status).toBe('active');
    });
    it('persists a clear request discovered in earlier history while required fields remain missing', async () => {
        const f = fixture();
        mocks.history.mockResolvedValue({ messages: { data: [{ id: 'request', from: { id: 'customer' },
            message: 'Please make a free concept', created_time: anchor }] } });
        expect(await processDueChatbotFollowUps({ supabase: f.db, now })).toMatchObject({ sent: 1, failed: 0 });
        expect(f.state).toMatchObject({ has_clear_request: true, request_type: 'free_concept',
            request_evidence: 'Please make a free concept', status: 'active' });
    });
    it('does not interrupt a newer customer message awaiting its webhook', async () => {
        const f = fixture();
        mocks.history.mockResolvedValue({ messages: { data: [{ id: 'new', from: { id: 'customer' },
            message: 'Manila po', created_time: '2026-10-17T05:00:30Z' }] } });
        expect(await processDueChatbotFollowUps({ supabase: f.db, now })).toMatchObject({ sent: 0, cancelled: 1 });
        expect(mocks.generate).not.toHaveBeenCalled();
    });
    it('cancels delivery when staff takes over during generation', async () => {
        const f = fixture();
        mocks.generate.mockImplementationOnce(async () => {
            f.state.status = 'stopped'; f.state.automation_epoch++;
            return { message: 'A draft', messages: ['A draft'] };
        });
        expect(await processDueChatbotFollowUps({ supabase: f.db, now })).toMatchObject({ sent: 0, cancelled: 1 });
        expect(mocks.send).not.toHaveBeenCalled();
    });
    it('does not replay a stale job that already delivered a bubble', async () => {
        const f = fixture(); f.job.message_id = 'earlier-bubble';
        expect(await processDueChatbotFollowUps({ supabase: f.db, now })).toMatchObject({ sent: 0, cancelled: 1 });
        expect(mocks.generate).not.toHaveBeenCalled();
        expect(mocks.send).not.toHaveBeenCalled();
    });
    it('checks persisted sent copy even when Messenger history has not caught up', async () => {
        const f = fixture();
        f.sentJobs.push({ id: 'earlier-job', message_id: 'earlier-mid', message_text: 'Ano pong location ng CJ Bakery?' });
        expect(await processDueChatbotFollowUps({ supabase: f.db, now })).toMatchObject({ sent: 0, cancelled: 1 });
        expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ previousFollowUpMessages: ['Ano pong location ng CJ Bakery?'] }));
        expect(mocks.send).not.toHaveBeenCalled();
    });
    it('allows a repeated form with saved answers and a fresh question through the delivery check', async () => {
        const f = fixture();
        const form = 'Para maihanda ang free concept, pakisagutan ang kulang dito.\n\n1. Business Name: CJ Bakery\n2. Business Location:\n3. Goal ng video:\n4. Contact Number:';
        f.sentJobs.push({ id: 'earlier-job', message_id: 'earlier-mid', message_text: form + '\n\nSaan located ang business?' });
        const messages = [form, 'Ano ang main goal mo para sa video?'];
        mocks.generate.mockResolvedValueOnce({ messages, message: messages.join('\n\n') });
        expect(await processDueChatbotFollowUps({ supabase: f.db, now })).toMatchObject({ sent: 1, cancelled: 0 });
        expect(mocks.send).toHaveBeenCalledTimes(2);
    });
    it.each(['qualified', 'not_qualified', 'converted', 'order_created', 'opted_out'])('never sends past an explicit %s lead stage', async pipeline_stage => {
        const f = fixture(); Object.assign(f.contact, { pipeline_stage, pipeline_stage_source: 'manual' });
        expect(await processDueChatbotFollowUps({ supabase: f.db, now })).toMatchObject({ sent: 0, cancelled: 1 });
        expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
    });
    it('checkpoints each delivered bubble and keeps a partial failure out of retry', async () => {
        const f = fixture();
        mocks.generate.mockResolvedValueOnce({ message: 'A specific answer.\n\nWhat is the location?', messages: ['A specific answer.', 'What is the location?'] });
        mocks.send.mockResolvedValueOnce({ message_id: 'first-bubble' }).mockRejectedValueOnce(new Error('Second send failed'));
        expect(await processDueChatbotFollowUps({ supabase: f.db, now })).toMatchObject({ sent: 0, failed: 1 });
        expect(f.writes).toContainEqual({ table: 'chatbot_follow_up_jobs', payload: expect.objectContaining({ message_id: 'first-bubble', message_text: 'A specific answer.' }) });
        expect(f.job.status).toBe('failed');
        expect(f.job.message_id).toBe('first-bubble');
    });
    it('cancels an exhausted duplicate draft without a five-minute retry loop', async () => {
        const f = fixture();
        mocks.generate.mockRejectedValueOnce(new ChatbotFollowUpRepeatedError('No fresh wording after two attempts'));
        expect(await processDueChatbotFollowUps({ supabase: f.db, now })).toMatchObject({ sent: 0, cancelled: 1, failed: 0 });
        expect(f.job.status).toBe('cancelled');
        expect(mocks.send).not.toHaveBeenCalled();
    });
});
