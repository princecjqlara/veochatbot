import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ analyze: vi.fn(), extract: vi.fn(), history: vi.fn(), conversation: vi.fn(), signal: vi.fn(), save: vi.fn(), pipeline: vi.fn() }));
vi.mock('@/lib/chatbot', () => ({ analyzeChatbotContinuation: mocks.analyze, extractChatbotContactDetails: mocks.extract }));
vi.mock('@/lib/facebook', () => ({ getConversationForPsid: mocks.conversation }));
vi.mock('@/lib/messaging-auto-tag', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/messaging-auto-tag')>(),
    loadMessengerHistoryForStopCheck: mocks.history, findLatestMessengerSystemSignal: mocks.signal }));
vi.mock('@/lib/contact-pipeline', () => ({ updateContactPipelineStage: mocks.pipeline, pipelineStageForMessengerSignal: (s: string) => s }));
vi.mock('@/lib/chatbot-control', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/chatbot-control')>(), saveChatbotContactState: mocks.save }));
import { getContinuationDetailTarget, processChatbotContinuationReviews } from '@/lib/chatbot-continuation';

const now = new Date('2026-10-16T12:00:00Z');
const fields = ['name', 'business', 'product', 'duration', 'deadline', 'script', 'purpose', 'idea', 'budget'];
function fixture() {
    const review = { id: 'review', state_id: 'state', page_id: 'page', contact_id: 'contact', collection_round: 0, attempt_count: 1 };
    const tables: Record<string, any> = {
        pages: { id: 'page', fb_page_id: 'fb-page', access_token: 'test-token' },
        contacts: { id: 'contact', psid: 'customer', pipeline_stage: 'qualified', pipeline_stage_source: 'chatbot', pipeline_stage_updated_at: now.toISOString(), last_inbound_at: '2026-10-16T10:00:00Z' },
        chatbot_configs: { enabled: true, follow_up_enabled: true, continuation_review_enabled: true, details_to_collect: fields },
        chatbot_contact_states: { id: 'state', status: 'stopped', stop_reason: 'details_collected', collection_round: 0, started_at: '2026-10-16T10:00:00Z', updated_at: now.toISOString(), collected_details: { name: 'CJ', business: 'Bakery', product: 'Bread' } }
    };
    const writes: any[] = [];
    const rpc = vi.fn(async (name: string) => ({ data: name === 'claim_chatbot_continuation_reviews' ? [review] : true, error: null }));
    const db = { rpc, from: (table: string) => {
        const chain: any = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: tables[table], error: null }),
            update: (payload: any) => { writes.push({ table, ...payload }); return chain; },
            then: (resolve: any) => Promise.resolve({ error: null }).then(resolve) };
        return chain;
    } };
    return { db, tables, writes, rpc, review };
}
beforeEach(() => {
    vi.clearAllMocks();
    mocks.conversation.mockResolvedValue({ messages: { data: [] } });
    mocks.history.mockResolvedValue([{ id: 'm1', from: { id: 'customer' }, message: 'How much for a bakery video?', created_time: '2026-10-16T10:00:00Z' }]);
    mocks.signal.mockReturnValue(null);
    mocks.analyze.mockResolvedValue({ purchase_status: 'undecided', confidence: 0.95, summary: 'Asked about price, no agreement', customer_evidence: 'How much for a bakery video?' });
});
describe('reviewed intake continuation', () => {
    it('adds three new answers without counting placeholders or unrelated fields', () => {
        expect(getContinuationDetailTarget(fields, { name: 'CJ', business: 'Bakery', product: 'unknown', other: 'x' })).toBe(5);
        expect(getContinuationDetailTarget(['name'], { name: 'CJ' })).toBeNull();
        expect(getContinuationDetailTarget(fields, Object.fromEntries(fields.slice(0, 8).map(f => [f, 'answer'])))).toBe(9);
    });
    it('resumes undecided bot-completed intake using atomic snapshot checks', async () => {
        const f = fixture();
        expect((await processChatbotContinuationReviews({ supabase: f.db, now })).resumed).toBe(1);
        expect(f.rpc).toHaveBeenCalledWith('resume_chatbot_continuation_review', expect.objectContaining({ p_target: 6, p_attempt: 1,
            p_state_updated_at: now.toISOString(), p_last_inbound_at: '2026-10-16T10:00:00Z' }));
    });
    it.each(['manual', 'messenger'])('cannot reopen a person-owned stage (%s)', async source => {
        const f = fixture(); f.tables.contacts.pipeline_stage_source = source;
        expect((await processChatbotContinuationReviews({ supabase: f.db, now })).skipped).toBe(1);
        expect(mocks.analyze).not.toHaveBeenCalled();
    });
    it.each(['converted', 'not_qualified', 'order_created', 'opted_out'])('cannot reopen %s', async stage => {
        const f = fixture(); f.tables.contacts.pipeline_stage = stage;
        expect((await processChatbotContinuationReviews({ supabase: f.db, now })).skipped).toBe(1);
        expect(f.rpc).toHaveBeenCalledTimes(1);
    });
    it.each(['agreed', 'declined', 'human_needed', 'unknown'])('keeps the bot stopped for AI purchase status %s', async purchase_status => {
        const f = fixture(); mocks.analyze.mockResolvedValue({ purchase_status, confidence: 0.99 });
        expect((await processChatbotContinuationReviews({ supabase: f.db, now })).keptStopped).toBe(1);
        expect(f.rpc).toHaveBeenCalledTimes(1);
    });
    it('keeps uncertain analysis stopped', async () => {
        const f = fixture(); mocks.analyze.mockResolvedValue({ purchase_status: 'undecided', confidence: 0.79 });
        expect((await processChatbotContinuationReviews({ supabase: f.db, now })).keptStopped).toBe(1);
    });
    it('applies a live Messenger handoff before analysis', async () => {
        const f = fixture(); mocks.signal.mockReturnValue('converted');
        expect((await processChatbotContinuationReviews({ supabase: f.db, now })).keptStopped).toBe(1);
        expect(mocks.save).toHaveBeenCalledWith(f.db, expect.objectContaining({ stopReason: 'converted' }));
        expect(mocks.analyze).not.toHaveBeenCalled();
    });
    it('does not resume after eligibility changes during the AI request', async () => {
        const f = fixture(); f.rpc.mockImplementation(async name => ({ data: name === 'claim_chatbot_continuation_reviews' ? [f.review] : false, error: null }));
        expect((await processChatbotContinuationReviews({ supabase: f.db, now })).skipped).toBe(1);
        expect(f.writes.at(-1).error_message).toContain('changed');
    });
    it('retries an unavailable analysis and gives up after three attempts without resuming', async () => {
        const f = fixture(); mocks.analyze.mockRejectedValue(new Error('Provider unavailable'));
        await processChatbotContinuationReviews({ supabase: f.db, now });
        expect(f.writes.at(-1).status).toBe('pending');
        f.review.attempt_count = 3;
        await processChatbotContinuationReviews({ supabase: f.db, now });
        expect(f.writes.at(-1).status).toBe('failed');
        expect(f.rpc.mock.calls.filter(([name]) => name === 'resume_chatbot_continuation_review')).toHaveLength(0);
    });
    it('does not analyze disabled pages or completed forms', async () => {
        const f = fixture(); f.tables.chatbot_configs.enabled = false;
        expect((await processChatbotContinuationReviews({ supabase: f.db, now })).skipped).toBe(1);
        expect(mocks.analyze).not.toHaveBeenCalled();
    });
});

const completeForm = { 'Business Name': 'Bakery', 'Business Location': 'Manila', 'Goal ng video': 'Promote our cakes', 'Contact Number': '09171234567' };
function nightlyFixture() {
    const f = fixture();
    Object.assign(f.review, { review_kind: 'nightly_handoff', automation_epoch: 4, policy_revision: 2 });
    Object.assign(f.tables.chatbot_configs, { commercial_video_intake_enabled: true, policy_revision: 2, updated_at: now.toISOString() });
    Object.assign(f.tables.contacts, { pipeline_stage: 'engaged', pipeline_stage_source: 'manual' });
    Object.assign(f.tables.chatbot_contact_states, { pause_kind: 'human_takeover', stop_reason: 'manual', automation_epoch: 4,
        last_human_activity_at: '2026-10-16T11:00:00Z', has_clear_request: false, request_type: null, request_evidence: null });
    mocks.extract.mockResolvedValue({ collected_details: { 'Business Name': 'Bakery' }, missing_details: [],
        has_clear_request: false, request_type: null, request_evidence: null });
    return f;
}
describe('commercial-video nightly handoff', () => {
    it.each([
        { complete: false, request: false, resumed: 1 },
        { complete: false, request: true, resumed: 0 },
        { complete: true, request: false, resumed: 1 },
        { complete: true, request: true, resumed: 0 }
    ])('resumes only without an agreement: complete=$complete and clear request=$request', async ({ complete, request, resumed }) => {
        const f = nightlyFixture();
        mocks.extract.mockResolvedValue({ collected_details: complete ? completeForm : { 'Business Name': 'Bakery' },
            has_clear_request: request, request_type: request ? 'free_concept' : null, request_evidence: request ? 'Free concept please' : null });
        const result = await processChatbotContinuationReviews({ supabase: f.db, now });
        expect(result.resumed).toBe(resumed);
        expect(result.keptStopped).toBe(1 - resumed);
        expect(mocks.history).toHaveBeenCalledWith(expect.objectContaining({ requireComplete: true, requireAvailable: true }));
        expect(mocks.analyze).not.toHaveBeenCalled();
        if (resumed) expect(f.rpc).toHaveBeenCalledWith('resume_chatbot_nightly_review', expect.objectContaining({
            p_config_updated_at: now.toISOString(), p_automation_epoch: 4, p_last_human_activity_at: '2026-10-16T11:00:00Z',
            p_collected_details: complete ? completeForm : { 'Business Name': 'Bakery' },
            p_has_clear_request: request, p_analysis: expect.objectContaining({ history_verified: true, needs_continuation: true })
        }));
    });
    it('accepts an acknowledged ordinary takeover and refreshes answers from the human exchange', async () => {
        const f = nightlyFixture();
        mocks.history.mockResolvedValue([
            { id: 'staff', from: { id: 'fb-page' }, message: 'Hi, how can I help?', created_time: '2026-10-16T11:00:00Z', tags: { data: [{ name: 'source:mobile' }] } },
            { id: 'customer', from: { id: 'customer' }, message: 'Bakery in Manila, please make a concept', created_time: '2026-10-16T10:00:00Z' }
        ]);
        expect((await processChatbotContinuationReviews({ supabase: f.db, now })).resumed).toBe(1);
        expect(mocks.extract).toHaveBeenCalledWith(expect.objectContaining({ history: expect.arrayContaining([expect.objectContaining({ id: 'staff' })]) }));
    });
    it('preserves an accepted free concept even when fresh extraction omits it', async () => {
        const f = nightlyFixture();
        Object.assign(f.tables.chatbot_contact_states, { has_clear_request: true, request_type: 'free_concept', request_evidence: 'Free concept please' });
        expect((await processChatbotContinuationReviews({ supabase: f.db, now })).keptStopped).toBe(1);
        expect(f.rpc.mock.calls.filter(([name]) => name === 'resume_chatbot_nightly_review')).toHaveLength(0);
    });
    it.each(['qualified', 'not_qualified', 'converted', 'order_created', 'opted_out'])('respects the explicit %s lead stage during nightly review', async pipeline_stage => {
        const f = nightlyFixture(); f.tables.contacts.pipeline_stage = pipeline_stage;
        expect((await processChatbotContinuationReviews({ supabase: f.db, now })).skipped).toBe(1);
        expect(mocks.extract).not.toHaveBeenCalled();
    });
    it('defers a newly discovered staff message to its own review episode', async () => {
        const f = nightlyFixture();
        mocks.history.mockResolvedValue([{ id: 'staff', from: { id: 'fb-page' }, created_time: '2026-10-16T11:10:00Z',
            message: 'I will help you', tags: { data: [{ name: 'source:mobile' }] } }]);
        expect((await processChatbotContinuationReviews({ supabase: f.db, now })).skipped).toBe(1);
        expect(mocks.save).toHaveBeenCalledWith(f.db, expect.objectContaining({ pauseKind: 'human_takeover', humanActivityAt: '2026-10-16T11:10:00.000Z' }));
        expect(mocks.extract).not.toHaveBeenCalled();
    });
    it('keeps durable outcomes stopped even when followed by an ordinary human message', async () => {
        const f = nightlyFixture();
        mocks.history.mockResolvedValue([
            { id: 'staff', from: { id: 'fb-page' }, created_time: '2026-10-16T11:00:00Z', message: 'Thanks', tags: { data: [{ name: 'source:mobile' }] } },
            { id: 'order', from: { id: 'fb-page' }, created_time: '2026-10-16T10:40:00Z', message: 'Lead stage set to Converted.' }
        ]);
        expect((await processChatbotContinuationReviews({ supabase: f.db, now })).keptStopped).toBe(1);
        expect(mocks.save).toHaveBeenCalledWith(f.db, expect.objectContaining({ stopReason: 'converted', pauseKind: 'explicit_hold' }));
        expect(mocks.extract).not.toHaveBeenCalled();
    });
    it.each(['explicit_hold', 'ready_for_team', null])('never reviews a %s pause', async pause_kind => {
        const f = nightlyFixture(); f.tables.chatbot_contact_states.pause_kind = pause_kind;
        expect((await processChatbotContinuationReviews({ supabase: f.db, now })).skipped).toBe(1);
        expect(mocks.history).not.toHaveBeenCalled();
    });
    it('does not resume with unreadable or incomplete history', async () => {
        const f = nightlyFixture(); mocks.history.mockRejectedValue(new Error('History pagination exhausted'));
        expect((await processChatbotContinuationReviews({ supabase: f.db, now })).failed).toBe(1);
        expect(f.writes.at(-1).status).toBe('pending');
        expect(f.rpc).toHaveBeenCalledTimes(1);
    });
    it('defers when a customer inbound has not yet been reconciled', async () => {
        const f = nightlyFixture();
        mocks.history.mockResolvedValue([{ id: 'new', from: { id: 'customer' }, message: 'Manila', created_time: '2026-10-16T11:30:00Z' }]);
        expect((await processChatbotContinuationReviews({ supabase: f.db, now })).failed).toBe(1);
        expect(mocks.extract).not.toHaveBeenCalled();
    });
    it('does not resume a stale snapshot after extraction', async () => {
        const f = nightlyFixture();
        f.rpc.mockImplementation(async name => ({ data: name === 'claim_chatbot_continuation_reviews' ? [f.review] : false, error: null }));
        expect((await processChatbotContinuationReviews({ supabase: f.db, now })).skipped).toBe(1);
        expect(f.writes.at(-1).error_message).toContain('changed');
    });
    it('does not send scoped Pages through legacy three-more-details reviews', async () => {
        const f = fixture(); f.tables.chatbot_configs.commercial_video_intake_enabled = true;
        expect((await processChatbotContinuationReviews({ supabase: f.db, now })).skipped).toBe(1);
        expect(mocks.extract).not.toHaveBeenCalled();
    });
});
