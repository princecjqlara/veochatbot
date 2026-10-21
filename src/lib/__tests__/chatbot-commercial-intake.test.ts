import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateChatbotFollowUp, generateChatbotResponse, extractChatbotContactDetails, formatChatbotReplyMessages, type ChatbotConfig } from '@/lib/chatbot';
import { COMMERCIAL_VIDEO_FIELDS, COMMERCIAL_VIDEO_REQUIRED_DETAILS, COMMERCIAL_VIDEO_OWNER_POLICY, hasCommercialVideoPriceList, hasForbiddenFreeVideoOffer, hasForbiddenFreePreproductionCharge, normalizeCommercialVideoDetails, normalizeCommercialVideoIntakeConfig, renderCommercialVideoForm } from '@/lib/chatbot-intake';
import { evaluateCommercialVideoIntake, extractClearVideoRequest, resolveCommercialVideoRequest } from '@/lib/chatbot-policy';
import { renderCommercialVideoSummary } from '@/lib/chatbot-message-renderer';
import type { FacebookMessage } from '@/types';
import { videoPreferences } from './fixtures/commercial-video';
import { retrieveChatbotKnowledge } from '@/lib/chatbot-knowledge';
vi.mock('@/lib/chatbot-knowledge', () => ({ retrieveChatbotKnowledge: vi.fn() }));

const config: ChatbotConfig = {
    page_id: 'page', enabled: true, instructions: 'Use the knowledge to answer prices.', fallback_reply: 'Team will reply.', model: 'test', rag_enabled: false,
    follow_up_prompt: '', details_to_collect: ['Product', 'Script'], details_completion_percent: 33, bot_dos: '', bot_donts: '',
    follow_up_enabled: true, follow_up_quick_delays_minutes: [5], follow_up_best_time_days: [1], follow_up_messages: [], follow_up_ai_instructions: 'Personalize the follow-up.',
    follow_up_utility_template_name: '', follow_up_utility_template_language: 'en_US', follow_up_utility_text: '', follow_up_media_asset_id: null,
    split_messages: true, max_message_parts: 0, stop_when_details_collected: true, stop_on_opt_out: true, stop_on_refusal: true,
    stop_on_qualified: true, stop_on_not_qualified: true, stop_on_converted: true, stop_on_order_created: true, commercial_video_intake_enabled: true
};
const complete = { ...videoPreferences, 'Business Name': 'CJ Bakery', 'Business Location': 'Manila', 'Goal ng video': 'Promote new bread', 'Contact Number': '09171234567' };
const customer = (text: string, second = 1): FacebookMessage => ({ id: `customer-${second}`, message: text, from: { id: 'customer', name: 'CJ' }, created_time: `2026-10-17T10:00:${String(second).padStart(2, '0')}Z` });
const page = (text: string, second = 0): FacebookMessage => ({ ...customer(text, second), id: `page-${second}`, from: { id: 'page', name: 'Page' } });
const completion = (plan: unknown) => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(plan) } }] }) });
const mockPlan = (plan: unknown) => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const mock = vi.fn().mockResolvedValue(completion(plan));
    vi.stubGlobal('fetch', mock);
    return mock;
};
it('honors a completed handoff even when the model repeats the form', async () => {
    mockPlan({ messages: [renderCommercialVideoForm()], collected_details: complete });
    const result = await generateChatbotResponse({ config, pageId: 'page', inboundMessage: 'Free script please',
        history: [customer('Free script please')], collectedDetails: complete,
        hasClearRequest: true, requestType: 'free_script', requestEvidence: 'Free script please' });
    expect(result.intake_action).toBe('handoff');
    expect(result.messages.join(' ')).not.toContain('gusto ninyong ipagawa');
    expect(result.messages.join(' ')).toContain('Ipapasa');
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); delete process.env.OPENROUTER_API_KEY; });

describe('canonical commercial form policy', () => {
    it('migrates explicit aliases, rejects placeholders and preserves the proper business identity', () => {
        expect(normalizeCommercialVideoDetails({ name: 'Messenger Name', 'company name': 'CJ Bakery', business_location: 'Manila', 'Video objective': 'Sell bread', phone: '+63 (917) 123-4567', budget: '5000' })).toEqual({ 'Business Name': 'CJ Bakery', 'Business Location': 'Manila', 'Goal ng video': 'Sell bread', 'Contact Number': '+639171234567' });
        expect(normalizeCommercialVideoDetails({ 'business name': 'pending', 'business location': 'unknown', 'video goal': 'N/A', 'phone number': '123' })).toEqual({});
        expect(normalizeCommercialVideoDetails({ name: 'Messenger Name', brand: 'Supplier Brand' })).toEqual({});
    });
    it.each(['00000000000', '11111111', '123', 'call me later', '1234567890123456'])('rejects unusable phone value %s', phone => {
        expect(normalizeCommercialVideoDetails({ phone })).toEqual({});
    });
    it('enforces the four-field target and 23:59 only for opted-in pages', () => {
        expect(normalizeCommercialVideoIntakeConfig(config)).toMatchObject({ details_to_collect: COMMERCIAL_VIDEO_REQUIRED_DETAILS, details_completion_percent: 100, continuation_review_hour: 23, continuation_review_minute: 59, stop_when_details_collected: false });
        const generic = { ...config, commercial_video_intake_enabled: false };
        expect(normalizeCommercialVideoIntakeConfig(generic)).toBe(generic);
    });
    it.each([
        [{}, false, true, 'send_form'], [{}, true, true, 'send_form'],
        [complete, false, true, 'clarify_next_step'], [complete, true, false, 'handoff']
    ] as const)('uses the confirmed OR rule for %j / request=%s', (details, request, continuation, action) => {
        expect(evaluateCommercialVideoIntake(details, request)).toMatchObject({ needsContinuation: continuation, nextAction: action });
    });
    it('keeps the full form in exactly one bubble after downstream formatting', () => {
        const messages = formatChatbotReplyMessages(['A'.repeat(600), ...renderCommercialVideoForm().split('\n')], config);
        expect(messages).toHaveLength(2);
        for (const field of COMMERCIAL_VIDEO_FIELDS) expect(messages[1]).toContain(field.displayLabel);
        expect(messages[1]).toBe(renderCommercialVideoForm());
    });
});

describe('grounded requests', () => {
    it.each(['How much for a commercial video?', 'Magkano magpagawa video?', 'I want to know the video price', 'Thanks', 'Yes', 'Can I see sample videos?', 'I want a free personalized sample video'])('keeps unclear or sample-only customer statement uncommitted: %s', text => {
        expect(extractClearVideoRequest([customer(text)], 'page').has_clear_request).toBe(false);
    });
    it.each([
        ['Gusto ko po magpagawa ng commercial video', 'commercial_video'],
        ['Can I get a free script?', 'free_script'], ['Free concept po', 'free_concept']
    ])('accepts direct request %s', (text, type) => {
        expect(extractClearVideoRequest([customer(text)], 'page')).toMatchObject({ has_clear_request: true, request_type: type, request_evidence: text });
    });
    it('grounds short acceptance in an actual preceding offer, never in a price quote', () => {
        expect(extractClearVideoRequest([customer('Yes po', 2), page('Gusto ninyo po ng free concept?', 1)], 'page')).toMatchObject({ has_clear_request: true, request_type: 'free_concept' });
        expect(extractClearVideoRequest([customer('Yes po', 2), page('A commercial video is 5000. Questions?', 1)], 'page').has_clear_request).toBe(false);
    });
    it('keeps a saved request across partial history and honors a later cancellation', () => {
        const saved = { pageId: 'page', hasClearRequest: true, requestType: 'free_script' as const, requestEvidence: 'Free script please' };
        expect(resolveCommercialVideoRequest({ ...saved, history: [customer('Thanks')] }).has_clear_request).toBe(true);
        expect(resolveCommercialVideoRequest({ ...saved, history: [customer('Thanks', 3), customer('Cancel my request', 2)] }).has_clear_request).toBe(false);
    });
    it('accepts contextual model candidates only with an actual customer request quote', () => {
        const requestCandidate = { has_clear_request: true, request_type: 'free_script', request_evidence: 'Proceed with that please' };
        expect(resolveCommercialVideoRequest({ pageId: 'page', history: [customer('Proceed with that please')], requestCandidate }).has_clear_request).toBe(true);
        expect(resolveCommercialVideoRequest({ pageId: 'page', history: [page('Proceed with that please')], requestCandidate }).has_clear_request).toBe(false);
        expect(resolveCommercialVideoRequest({ pageId: 'page', history: [customer('How much for the script please?')], requestCandidate: { ...requestCandidate, request_evidence: 'How much for the script please?' } }).has_clear_request).toBe(false);
    });
});

describe('commercial generation and follow-ups', () => {
    const prices = [{ title: 'Prices', content: '24-second AI commercial video: PHP899 total. PHP150 down payment and PHP749 balance.', document_id: 'prices', chunk_id: 'prices-1', similarity: 1 }];
    const sample = { title: '[video] Bakery portfolio', content: 'MEDIA ASSET (video): Existing bakery commercial sample.', document_id: 'bakery-sample', chunk_id: 'sample-1', similarity: 1 };
    it('answers a direct pricing question before asking the business, without introducing the form', async () => {
        const fetchMock = mockPlan({ messages: ['PHP899 ang 24-second video. PHP150 muna ang down payment.'], collected_details: {} });
        const result = await generateChatbotResponse({ config, pageId: 'page', contactName: 'CJ Lara', inboundMessage: 'Magkano ang 24-second video?', knowledge: prices });
        expect(result.messages[0]).toContain('PHP899'); expect(result.messages.at(-1)).toMatch(/business.*\?$/);
        expect(result.messages.join(' ')).toContain('CJ,'); expect(result.messages.join(' ')).not.toContain('Lara');
        expect(result.messages.join(' ')).not.toContain('Business Name:'); expect(result.intake_action).toBe('none');
        const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content;
        expect(prompt).toContain('24-second AI commercial video: PHP899'); expect(prompt).toContain('CURRENT VERIFIED SALES FLOW');
        expect(prompt).toContain('"step":"business"'); expect(prompt).not.toContain('Split each short ordinary sentence');
    });
    it('sends an existing relevant sample from the same knowledge library after business discovery', async () => {
        mockPlan({ messages: ['Ito ang sample.'], business_type: 'bakery', collected_details: {}, media_document_ids: ['bakery-sample'] });
        const result = await generateChatbotResponse({ config, pageId: 'page', contactName: 'CJ Lara', inboundMessage: 'Bakery po',
            history: [page('Anong business ang gusto mong gawan ng commercial video?')], knowledge: [sample] });
        expect(result.media_document_ids).toEqual(['bakery-sample']); expect(result.messages[0]).toContain('existing sample');
        expect(result.messages.at(-1)).toMatch(/seconds.*\?$/); expect(result.collected_details).toEqual({});
    });
    it('replaces an invented sample ID with a relevant existing asset from the same library', async () => {
        mockPlan({ messages: ['Ito ang sample.'], collected_details: {}, media_document_ids: ['invented'] });
        const result = await generateChatbotResponse({ config, pageId: 'page', inboundMessage: 'Bakery po', knowledge: [sample] });
        expect(result.media_document_ids).toEqual(['bakery-sample']); expect(result.messages[0]).toContain('existing sample');
    });
    it('attaches a relevant existing sample even when the model forgets to select one', async () => {
        mockPlan({ messages: ['Sige po.'], collected_details: {} });
        const result = await generateChatbotResponse({ config, pageId: 'page', inboundMessage: 'Bakery po', knowledge: [sample] });
        expect(result.media_document_ids).toEqual(['bakery-sample']); expect(result.messages[0]).toContain('existing sample');
    });
    it('keeps an unavailable sample honest rather than choosing unrelated portfolio', async () => {
        mockPlan({ messages: ['Sige po.'], collected_details: {} });
        const unrelated = { ...sample, title: '[video] Resort portfolio', content: 'MEDIA ASSET (video): Existing resort commercial sample.' };
        const result = await generateChatbotResponse({ config, pageId: 'page', inboundMessage: 'Bakery po', knowledge: [unrelated] });
        expect(result.media_document_ids).toBeUndefined(); expect(result.messages[0]).toMatch(/wala pa akong verified sample/i);
    });
    it('applies the verified-sample fallback to scheduled follow-ups too', async () => {
        vi.mocked(retrieveChatbotKnowledge).mockResolvedValueOnce([sample]);
        mockPlan({ messages: ['Para sa bakery video mo.'], personalization_basis: 'Customer asked for a bakery commercial' });
        const result = await generateChatbotFollowUp({ config: { ...config, rag_enabled: true }, pageId: 'page',
            history: [customer('Bakery po ang business namin')], collectedDetails: { 'Business Name': 'CJ Bakery' }, sequenceNumber: 1, scheduleLabel: 'preview' });
        expect(result.media_document_ids).toEqual(['bakery-sample']); expect(result.messages[0]).toContain('existing sample');
    });
    it('sends complete pricing, the seven-step process and a buying question after the duration answer', async () => {
        mockPlan({ messages: ['PHP899 ang 24-second video. PHP150 ang down payment, PHP749 ang balance.'], collected_details: {} });
        const history = [customer('Bakery po', 1), page('Ito ang existing sample namin na related sa bakery.', 2), page('Ilang seconds ang gusto mo?', 3)];
        const result = await generateChatbotResponse({ config, pageId: 'page', contactName: 'CJ Lara', inboundMessage: '24 seconds', history, knowledge: prices });
        expect(result.messages).toHaveLength(3); expect(result.messages[0]).toContain('PHP899');
        expect(result.messages[1]).toContain('STEP-BY-STEP PROCESS PO:'); expect(result.messages[1]).toContain('PHP100');
        expect(result.messages.at(-1)).toMatch(/mag-proceed.*form\?$/); expect(result.messages.join(' ')).not.toContain('Business Name:');
    });
    it('honors an explicit form request and saves answers already supplied', async () => {
        mockPlan({ messages: ['Sige po.'], collected_details: { 'Business Name': 'CJ Bakery' } });
        const result = await generateChatbotResponse({ config, pageId: 'page', contactName: 'CJ Lara', inboundMessage: 'Pakisend ng form, CJ Bakery ang business name' });
        expect(result.intake_action).toBe('send_form'); expect(result.messages.filter(m => m.includes('Kindly fill out these details:'))).toHaveLength(1);
        expect(result.messages.join(' ')).toContain('Business Name: CJ Bakery'); expect(result.messages.at(-1)).toMatch(/page|social/i);
        expect(formatChatbotReplyMessages(result.messages, { split_messages: false, max_message_parts: 1 })).toEqual(result.messages);
    });
    it('requires all four fields despite obsolete detail targets and carries a saved free request', async () => {
        mockPlan({ messages: ['Anong contact number po ang pwede naming gamitin?'], collected_details: {} });
        const result = await generateChatbotResponse({ config, pageId: 'page', inboundMessage: 'Salamat', history: [page(renderCommercialVideoForm())],
            collectedDetails: { ...complete, 'Contact Number': '' }, detailTargetCount: 1, hasClearRequest: true, requestType: 'free_script', requestEvidence: 'Free script please' });
        expect(result.details_complete).toBe(false); expect(result.missing_details).toEqual(['Contact Number']); expect(result.has_clear_request).toBe(true);
        expect(result.messages.join(' ')).not.toContain('1. Business Name:'); expect(result.messages.at(-1)).toMatch(/\?$/);
    });
    it('extracts multiple answers and corrections without turning form completion into purchase consent', async () => {
        mockPlan({ messages: ['Noted po.'], collected_details: { company_name: 'New Bakery', business_location: 'QC', video_goal: 'Promote bread', contact_number: '0917 123 4567' } });
        const result = await generateChatbotResponse({ config, pageId: 'page', inboundMessage: 'Correction: New Bakery sa QC', collectedDetails: complete });
        expect(result.collected_details).toEqual({ ...complete, 'Business Name': 'New Bakery', 'Business Location': 'QC' });
        expect(result.details_complete).toBe(true); expect(result.has_clear_request).toBe(false); expect(result.intake_action).toBe('clarify_next_step');
    });
    it.each(['reply', 'follow_up'])('removes emojis, full-name salutations, Markdown and AI labels in a %s', async mode => {
        mockPlan({ messages: ['Sir CJ Lara, **Pwede po.** - kasama ang script. \u{1F44D}', 'Generated by AI.'], collected_details: {}, personalization_basis: 'Customer asked about bakery video' });
        const input = { config, pageId: 'page', contactName: 'CJ Lara', history: [customer('Pwede sa bakery video?')], collectedDetails: { 'Business Name': 'CJ Bakery' } };
        const result = mode === 'reply' ? await generateChatbotResponse({ ...input, inboundMessage: 'Pwede sa bakery video?' }) : await generateChatbotFollowUp({ ...input, sequenceNumber: 1, scheduleLabel: '5 minutes' });
        expect(result.messages.join(' ')).not.toMatch(/\p{Extended_Pictographic}|Lara|Sir|Generated by AI|\*|\s-\s/u);
        expect(result.messages.join(' ')).toContain('CJ,'); expect(result.messages.at(-1)).toMatch(/\?$/);
    });
    it('does not resend an existing form or restart discovery after a partial answer', async () => {
        mockPlan({ messages: [renderCommercialVideoForm()], collected_details: { 'Business Location': 'Manila' } });
        const result = await generateChatbotResponse({ config, pageId: 'page', inboundMessage: 'Manila po', history: [page(renderCommercialVideoForm())], collectedDetails: { 'Business Name': 'CJ Bakery' } });
        expect(result.intake_action).toBe('ask_missing_field'); expect(result.messages.join(' ')).not.toContain('Business Name:');
        expect(result.messages.at(-1)).toMatch(/page|social/i);
    });
    it('retries unauthorized personalized sample promises from stale instructions', async () => {
        process.env.OPENROUTER_API_KEY = 'test-key';
        const fetchMock = vi.fn().mockResolvedValueOnce(completion({ messages: ['We can create a free personalized video sample.'], collected_details: {} }))
            .mockResolvedValueOnce(completion({ messages: ['May free concept o free script.'], collected_details: {} }));
        vi.stubGlobal('fetch', fetchMock);
        const result = await generateChatbotResponse({ config, pageId: 'page', inboundMessage: 'Pwede po ba?' });
        expect(fetchMock).toHaveBeenCalledTimes(2); expect(result.messages.join(' ')).not.toContain('free personalized');
    });
    it.each(['reply', 'follow_up'])('rejects a price catalog in a %s but preserves the verified selected-option rate', async mode => {
        process.env.OPENROUTER_API_KEY = 'test-key';
        const plan = (text: string) => ({ messages: [text], personalization_basis: 'Customer asked bakery video pricing', collected_details: {} });
        const fetchMock = vi.fn().mockResolvedValueOnce(completion(plan('8s: PHP399. 16s: PHP699. 24s: PHP899.')))
            .mockResolvedValueOnce(completion(plan('PHP899 ang 24-second video. PHP150 ang down payment, PHP749 ang balance.')));
        vi.stubGlobal('fetch', fetchMock);
        const input = { config, pageId: 'page', history: [customer('Magkano sa 24-second bakery video?')], collectedDetails: { 'Business Name': 'CJ Bakery' } };
        const result = mode === 'reply' ? await generateChatbotResponse({ ...input, inboundMessage: 'Magkano po?', knowledge: prices }) : await generateChatbotFollowUp({ ...input, sequenceNumber: 1, scheduleLabel: '5 minutes' });
        expect(fetchMock).toHaveBeenCalledTimes(2); expect(result.messages.join(' ')).not.toMatch(/399|699/); expect(result.messages.join(' ')).toContain('PHP899'); expect(result.messages.at(-1)).toMatch(/\?$/);
    });
    it('keeps scheduled follow-ups on the current flow without introducing a form early', async () => {
        mockPlan({ messages: ['Para sa bakery video mo, anong duration ang gusto mo?'], personalization_basis: 'Customer asked about bakery video' });
        const result = await generateChatbotFollowUp({ config, contactName: 'CJ Lara', pageId: 'page', history: [customer('Bakery po'), page('Ito ang existing sample namin para sa bakery.', 2)], sequenceNumber: 1, scheduleLabel: '5 minutes' });
        expect(result.messages.join(' ')).not.toContain('Business Name:'); expect(result.messages.join(' ')).toContain('CJ,'); expect(result.messages.at(-1)).toMatch(/seconds.*\?$/);
    });
    it('does not repeat a model-written summary or ignore a selected free output', async () => {
        mockPlan({ messages: [renderCommercialVideoSummary(complete), 'Ipapasa po ito sa team.'], collected_details: {} });
        const result = await generateChatbotResponse({ config, pageId: 'page', inboundMessage: 'Free script please', collectedDetails: complete });
        for (const field of COMMERCIAL_VIDEO_FIELDS) expect(result.messages.join('\n').split(field.displayLabel)).toHaveLength(2);
        expect(result.messages.join(' ')).toContain('Walang bayad'); expect(result.messages.at(-1)).toMatch(/\?$/);
    });
    it('extracts details silently without generating a sales reply', async () => {
        mockPlan({ collected_details: { business_name: 'CJ Bakery', business_location: 'Manila' } });
        const result = await extractChatbotContactDetails({ config, pageId: 'page', inboundMessage: 'CJ Bakery sa Manila' });
        expect(result.collected_details).toMatchObject({ 'Business Name': 'CJ Bakery', 'Business Location': 'Manila' });
    });
    it.each(['reply', 'silent'])('does not invent a video goal from a business and service request during %s collection', async mode => {
        mockPlan({ messages: ['Sige po.'], collected_details: { 'Business Name': 'CJ Bakery', 'Goal ng video': 'Bakery commercial video' } });
        const input = { config, pageId: 'page', inboundMessage: 'Gusto ko ng commercial video para sa CJ Bakery.' };
        const result = mode === 'reply' ? await generateChatbotResponse(input) : await extractChatbotContactDetails(input);
        expect(result.collected_details['Business Name']).toBe('CJ Bakery'); expect(result.collected_details['Goal ng video']).toBeUndefined();
    });
    it('keeps one authoritative policy and removes stale sentence-splitting instructions', async () => {
        const fetchMock = mockPlan({ messages: ['Pwede po.'], collected_details: {} });
        const saved = 'Custom Page guidance.\n\nForm incentive and sentence splitting policy (2026-10-18): split every sentence.';
        await generateChatbotResponse({ config: { ...config, instructions: saved, bot_dos: saved, bot_donts: saved, follow_up_prompt: saved }, pageId: 'page', inboundMessage: 'Hello' });
        const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content;
        expect(prompt).toContain('Custom Page guidance.'); expect(prompt).not.toContain('split every sentence');
        expect(prompt.split(COMMERCIAL_VIDEO_OWNER_POLICY)).toHaveLength(2);
    });
    it('honors an opt-out without restarting the sales flow or asking another question', async () => {
        mockPlan({ messages: ['Okay po, hindi na kami magme-message.'], collected_details: {}, stop_reason: 'opt_out' });
        const result = await generateChatbotResponse({ config, pageId: 'page', inboundMessage: 'Stop messaging me' });
        expect(result.detected_stop_reason).toBe('opt_out'); expect(result.messages.join(' ')).not.toContain('?');
        expect(result.messages.join(' ')).not.toContain('Business Name:');
    });
});

describe('offer validation', () => {
    it.each(['8s: ₱399\n16s: ₱699', 'PHP399 for 8s, PHP699 for 16s.', '8s - 399; 16s - 699', 'Starter 399 pesos. Pro 699 pesos.'])('blocks a package price catalog: %s', text => {
        expect(hasCommercialVideoPriceList(text)).toBe(true);
    });
    it.each(['PHP899 po ang 24-second video. PHP150 ang deposit, PHP749 ang balance.', 'The selected package is 699 pesos.', 'Wala pong bayad ang free script.'])('allows a selected rate or its payment breakdown: %s', text => {
        expect(hasCommercialVideoPriceList(text)).toBe(false);
    });
    it.each(['A quote for the free script.', 'Exact quote para sa free script ninyo.', 'Payment for your free concept.'])('rejects charging or quoting a free output: %s', text => {
        expect(hasForbiddenFreePreproductionCharge(text)).toBe(true);
    });
    it.each(['Free script po ito, walang bayad.', 'There is no fee for the free concept.', 'No quote for the free script is needed.', 'The free script is available. The paid commercial video needs a scope-based quote.'])('allows free outputs and separate paid quotes: %s', text => {
        expect(hasForbiddenFreePreproductionCharge(text)).toBe(false);
    });
    it.each(['Free concept for your video', 'Free script', 'FREE poster ads for the commercial video.', 'The personalized video is not free.', 'You may view our existing portfolio samples for free.'])('allows authorized offer or clarification: %s', text => {
        expect(hasForbiddenFreeVideoOffer(text)).toBe(false);
    });
    it.each(['We offer a free personalized video sample.', 'Gagawan ka namin ng libreng video.', 'We can create a custom video for free.'])('rejects unauthorized offer: %s', text => {
        expect(hasForbiddenFreeVideoOffer(text)).toBe(true);
    });
});
