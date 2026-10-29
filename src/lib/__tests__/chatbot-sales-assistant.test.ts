import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateChatbotResponse, generateChatbotFollowUp, type ChatbotConfig } from '@/lib/chatbot';
import { DEFAULT_SALES_SETTINGS, mergeSalesChatDetails, salesSettings, salesDetailProgress, salesAssumptions, validateSalesSettings, type SalesProgress } from '@/lib/chatbot-sales-assistant';
import { createSalesFormToken, verifySalesFormToken, mergeSalesRecord } from '@/lib/chatbot-sales-store';
import { getPricingQuoteContext } from '@/lib/chatbot-pricing';
import { evaluateCommercialVideoIntake } from '@/lib/chatbot-policy';
import { OWNER_PRICING_CATALOGS } from '@/lib/chatbot-pricing-catalogs';
import type { FacebookMessage } from '@/types';
import { videoPreferences } from './fixtures/commercial-video';

const config = { commercial_video_intake_enabled: true, sales_assistant_settings: {}, page_id: 'page', enabled: true,
    model: 'test', instructions: 'Natural Taglish, no emojis.', rag_enabled: false, details_to_collect: [], details_completion_percent: 100,
    follow_up_ai_instructions: 'Read previous messages.', split_messages: true } as unknown as ChatbotConfig;
const settings = salesSettings({});
const complete = { 'Business Name': 'Tea House', 'Business Industry': 'Restaurant', 'Product or Service': 'Lechon belly', 'Preferred Style': 'Realistic', 'Goal ng video': 'Increase orders' };
const history: FacebookMessage[] = [{ id: 'one', from: { id: 'page', name: 'Page' }, message: 'Optional quick form: puwede rin tayong mag-chat. SALES PROCESS:', created_time: '2026-10-30T01:00:00Z' }];
const progress: SalesProgress = { introduced_at: '2026-10-30T01:00:00Z', form_offered_at: '2026-10-30T01:00:00Z' };
const sample = { chunk_id: 'sample-chunk', document_id: '10000000-0000-4000-8000-000000000001', title: '[video] Food restaurant realistic sample', content: 'MEDIA ASSET (video)\nLechon belly restaurant food', similarity: 1 };
const input = { config, pageId: 'page', knowledge: [sample], history, salesProgress: progress };
function plan(details: Record<string, string> = {}, messages = ['Bagay sa business mo ang close-up shots para malinaw ang product.'], extra = {}) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ messages, collected_details: details,
        personalization_basis: 'Customer wants a realistic food commercial', media_decision_reason: 'Food business', ...extra }) } }] }) }));
}
beforeEach(() => { process.env.OPENROUTER_API_KEY = 'test'; plan(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); delete process.env.OPENROUTER_API_KEY; delete process.env.CHATBOT_FORM_SECRET; });

describe('required sales scenarios', () => {
    it('1. New inquiry explains the process and offers the optional form immediately', async () => {
        const result = await generateChatbotResponse({ ...input, inboundMessage: 'Hello po', history: [], salesProgress: undefined, formUrl: 'https://agency.test/sales-form?token=signed' });
        expect(result.reply).toContain('STEP 1:'); expect(result.reply).toContain('Optional quick form'); expect(result.reply).toContain('o tuloy lang tayo sa chat');
        expect(fetch).not.toHaveBeenCalled(); expect(result.reply).not.toMatch(/PHP\d|\p{Extended_Pictographic}/u);
    });
    it('2. Ignoring the form continues conversation and education with one question', async () => {
        plan({ 'Business Industry': 'Restaurant' });
        const result = await generateChatbotResponse({ ...input, inboundMessage: 'Restaurant po' });
        expect(result.collected_details['Business Industry']).toBe('Restaurant'); expect(result.reply).toContain('close-up');
        expect(result.reply.match(/\?/g)).toHaveLength(1); expect(result.reply).not.toContain('Optional quick form');
    });
    it('3. Partial form asks only for a missing relevant field', async () => {
        const result = await generateChatbotResponse({ ...input, collectedDetails: { 'Business Name': 'Tea House', 'Business Industry': 'Restaurant' }, inboundMessage: 'Tuloy po' });
        expect(result.reply).toContain('Anong product o service'); expect(result.reply).not.toContain('Ano ang pangalan');
    });
    it('4. Complete sales form recommends an actual relevant sample and purchase step', async () => {
        const result = await generateChatbotResponse({ ...input, collectedDetails: complete, inboundMessage: 'Submitted na po' });
        expect(result.media_document_ids).toEqual([sample.document_id]); expect(result.reply).toContain('Lechon belly');
        expect(result.reply).toContain('mag-proceed'); expect(result.reply).not.toContain('Ano ang pangalan'); expect(result.reply).not.toContain('Kindly fill');
    });
    it('5. Messenger details synchronize while inferred categories remain suggestions', () => {
        const details = mergeSalesChatDetails({}, {}, ['May milk tea shop po ako.'], 'May milk tea shop po ako.', settings);
        expect(details['Product or Service']).toMatch(/milk tea/i); expect(details['Business Industry']).toMatch(/milk tea/i);
        expect(salesAssumptions(details, settings)).toEqual({ 'Industry Category': 'Food & Beverage' });
        expect(details['Business Name']).toBeUndefined();
    });
    it('6. Customer corrections replace earlier values; guesses do not replace confirmed answers', async () => {
        plan({ 'Business Name': 'Tea House' });
        const result = await generateChatbotResponse({ ...input, collectedDetails: { 'Business Name': 'Old Name' }, inboundMessage: 'Tea House po pangalan.' });
        expect(result.collected_details['Business Name']).toBe('Tea House');
        expect(mergeSalesChatDetails(complete, { 'Business Name': 'Invented', 'Goal ng video': 'Brand awareness' }, ['hello'], 'hello', settings)).toEqual(complete);
    });
    it('7. Pricing OFF acknowledges a price question without disclosure or a new handoff', async () => {
        plan({}, ['Package price PHP999. PHP150 deposit.']);
        const result = await generateChatbotResponse({ ...input, pricingCatalog: OWNER_PRICING_CATALOGS[0], inboundMessage: 'Magkano?' });
        expect(result.reply).toContain('exact pricing'); expect(result.reply).not.toMatch(/PHP\s*\d|BUONG PRICE LIST|PHP150|999/);
        expect(result.intake_action).not.toBe('handoff'); expect(getPricingQuoteContext({ config, pageId: 'page', inboundMessage: 'Magkano?' }).eligible).toBe(false);
    });
    it('8. Pricing ON uses approved catalogs even without any form answers', async () => {
        const on = { ...config, sales_assistant_settings: { pricing_enabled: true } };
        const result = await generateChatbotResponse({ ...input, config: on, pricingCatalog: OWNER_PRICING_CATALOGS[0], inboundMessage: 'Magkano?' });
        expect(result.reply).toContain('PHP999'); expect(result.reply).toContain('BUONG PRICE LIST'); expect(result.reply).toContain('poster');
        expect(getPricingQuoteContext({ config: on, pageId: 'page', inboundMessage: 'Magkano?' }).eligible).toBe(true);
    });
    it('9. Handoff criteria stay identical and all collected information remains available', async () => {
        const old = { ...videoPreferences, 'Business Name': 'Tea House', 'Business Location': 'Manila', 'Goal ng video': 'Increase orders', 'Contact Number': '09171234567' };
        const result = await generateChatbotResponse({ ...input, collectedDetails: { ...old, ...complete }, inboundMessage: 'Gusto ko magpagawa ng commercial video.',
            hasClearRequest: true, requestType: 'commercial_video', requestEvidence: 'Gusto ko magpagawa ng commercial video.' });
        expect(result.intake_action).toBe('handoff'); expect(result.reply).toContain('Ipapasa sa team');
        expect(result.collected_details).toMatchObject(complete); expect(evaluateCommercialVideoIntake(old, true).needsContinuation).toBe(false);
        expect(evaluateCommercialVideoIntake(complete, true).needsContinuation).toBe(true);
    });
    it('10. Follow-up uses saved context and does not re-offer the form or restart', async () => {
        const result = await generateChatbotFollowUp({ config, pageId: 'page', history: [...history, { id: 'c', from: { id: 'customer', name: 'C' }, message: 'Restaurant po', created_time: '2026-10-30T01:01:00Z' }],
            collectedDetails: complete, salesProgress: progress, sequenceNumber: 1, scheduleLabel: 'first 24 hours' });
        expect(result.message).not.toContain('STEP 1'); expect(result.message).not.toContain('Optional quick form');
        expect(result.message).toContain('mag-proceed'); expect(result.sales_progress?.stage).toBe('follow_up');
    });
    it('11. Returning customers resume saved progress even when recent history is missing', async () => {
        const result = await generateChatbotResponse({ ...input, history: [], collectedDetails: complete, inboundMessage: 'Hello po' });
        expect(result.reply).not.toContain('STEP 1'); expect(result.reply).not.toContain('Optional quick form'); expect(result.reply).toContain('mag-proceed');
    });
    it('12. Immediate buying intent bypasses form and discovery without changing handoff triggers', async () => {
        const text = 'Gusto ko magpagawa ng commercial video.';
        const result = await generateChatbotResponse({ ...input, history: [], salesProgress: undefined, inboundMessage: text, hasClearRequest: true,
            requestType: 'commercial_video', requestEvidence: text });
        expect(result.reply).toContain('simulan natin'); expect(result.reply).not.toContain('Optional quick form'); expect(result.reply).not.toContain('STEP 1');
        expect(result.sales_progress?.temperature).toBe('hot'); expect(result.intake_action).not.toBe('handoff');
    });
});
describe('data, security and recommendation guards', () => {
    it('preserves explicit approved Drive-folder requests through the existing link delivery path', async () => {
        const folder = { ...sample, title: '[Drive folder] Restaurant portfolio', content: 'GOOGLE DRIVE MEDIA FOLDER: Restaurant portfolio' };
        plan({}, ['Ito ang existing portfolio folder para sa restaurant mo.'], { link_document_id: folder.document_id });
        const result = await generateChatbotResponse({ ...input, knowledge: [folder], collectedDetails: complete, inboundMessage: 'Send the sample folder please' });
        expect(result.link_document_id).toBe(folder.document_id);
    });
    it('preserves accepted free scripts without charging, upselling them as paid production, or marking them as paid buying intent', async () => {
        const result = await generateChatbotResponse({ ...input, collectedDetails: complete, inboundMessage: 'Free script please', hasClearRequest: true,
            requestType: 'free_script', requestEvidence: 'Free script please' });
        expect(result.reply).toContain('ihanda natin ang free script'); expect(result.reply).toContain('Walang bayad');
        expect(result.reply).not.toContain('simulan natin ang commercial'); expect(result.sales_progress?.temperature).toBe('warm');
    });
    it('continues accepted purchases through existing production questions without asking for buying consent again', async () => {
        const result = await generateChatbotResponse({ ...input, collectedDetails: complete, inboundMessage: 'Gusto ko magpagawa ng commercial video.',
            hasClearRequest: true, requestType: 'commercial_video', requestEvidence: 'Gusto ko magpagawa ng commercial video.' });
        expect(result.reply).toContain('page o social media'); expect(result.reply).not.toContain('ready ka na bang mag-proceed');
        expect(result.reply.match(/\?/g)).toHaveLength(1);
    });
    it('introduces the process when the first inquiry already contains business details', async () => {
        const result = await generateChatbotResponse({ ...input, history: [], salesProgress: undefined, inboundMessage: 'May restaurant po ako.' });
        expect(result.reply).toContain('STEP 1:'); expect(result.reply).toContain('Optional quick form');
    });
    it('never mistakes a niche for a business name or a rejection for a confirmed preference', () => {
        const niche = mergeSalesChatDetails({}, {}, ['Restaurant po'], 'Restaurant po', settings, settings.fields[0].question);
        expect(niche['Business Name']).toBeUndefined();
        const corrected = mergeSalesChatDetails({ 'Preferred Style': 'Animated' }, { 'Preferred Style': 'Realistic' }, ['Hindi realistic ang gusto ko.'], 'Hindi realistic ang gusto ko.', settings);
        expect(corrected['Preferred Style']).toBe('Animated');
    });
    it('rejects forged and expired form tokens', () => {
        process.env.CHATBOT_FORM_SECRET = 'test-secret';
        const token = createSalesFormToken('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 1000)!;
        expect(verifySalesFormToken(token, 1001)?.contactId).toBe('20000000-0000-4000-8000-000000000002');
        expect(verifySalesFormToken(token + 'x', 1001)).toBeNull(); expect(verifySalesFormToken(token, 1000 + 7 * 86400000)).toBeNull();
    });
    it('does not send inactive or repeated sample assignments', async () => {
        const result = await generateChatbotResponse({ ...input, config: { ...config, sales_assistant_settings: { samples: [{ document_id: sample.document_id, active: false }] } },
            collectedDetails: complete, inboundMessage: 'Tuloy' });
        expect(result.media_document_ids).toBeUndefined();
        const repeated = await generateChatbotResponse({ ...input, salesProgress: { ...progress, samples_sent: [sample.document_id] }, collectedDetails: complete, inboundMessage: 'Tuloy' });
        expect(repeated.media_document_ids).toBeUndefined();
    });
    it('passes only changed keys into the atomic shared-record update', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: { state: { collected_details: complete }, conflicts: [], duplicate: false } });
        await mergeSalesRecord({ rpc }, { pageId: 'p', contactId: 'c', details: complete, base: { ...complete, 'Business Name': 'Old' }, source: 'chat', eventKey: 'test-key', observedAt: '2026-10-30T00:00:00Z' });
        expect(rpc.mock.calls[0][1].p_patch).toEqual({ 'Business Name': 'Tea House' });
    });
    it('supports configurable optional fields without changing legacy handoff completeness', () => {
        const custom = validateSalesSettings({ ...DEFAULT_SALES_SETTINGS, fields: [{ label: 'Audience', question: 'Sino ang target audience mo?', required: true, enabled: true }] });
        expect(salesDetailProgress({ Audience: 'Students' }, custom).complete).toBe(true);
        expect(evaluateCommercialVideoIntake({ Audience: 'Students' }, true).needsContinuation).toBe(true);
    });
});
