import { describe, expect, it } from 'vitest';
import { renderCommercialVideoMessages, renderCommercialVideoProcess, renderCommercialVideoSummary } from '@/lib/chatbot-message-renderer';
import { containsCommercialVideoForm, renderCommercialVideoForm } from '@/lib/chatbot-intake';
import { formatChatbotReplyMessages } from '@/lib/chatbot';
import type { CommercialVideoSalesFlow } from '@/lib/chatbot-sales-flow';
import { videoPreferences } from './fixtures/commercial-video';
const complete = { ...videoPreferences, 'Business Name': 'CJ Bakery', 'Business Location': 'Manila', 'Goal ng video': 'Promote bread', 'Contact Number': '09171234567' };
const flow = (step: CommercialVideoSalesFlow['step'], extra = {}): CommercialVideoSalesFlow => ({ step, business: 'CJ Bakery', durationSeconds: 24, sampleSent: true, sampleHandled: true, processSent: false, pricingSent: false, formSent: false, formRequested: false, processRequested: false, ...extra });
const render = (extra: Partial<Parameters<typeof renderCommercialVideoMessages>[0]> = {}) => renderCommercialVideoMessages({ parts: [], details: {}, action: 'none', contactName: 'CJ Lara', ...extra });

describe('natural commercial-video replies and intact structured messages', () => {
    it('splits ordinary sentences even beside a form while preserving its complete fields', () => {
        const messages = render({ parts: ['Kasama ang script. Pwede ang vertical format.'], salesFlow: flow('form'), splitMessages: true });
        expect(messages[0]).toContain('Kasama ang script.');
        expect(messages[1]).toBe('Pwede ang vertical format.');
        expect(messages.filter(containsCommercialVideoForm)).toHaveLength(1);
        expect(formatChatbotReplyMessages(messages, { split_messages: true, max_message_parts: 1 })).toEqual(messages);
    });
    it('opens with a personalized business question and no form', () => {
        const messages = render({ parts: ['Hi sir \u{1F44B}', renderCommercialVideoForm()], salesFlow: flow('business', { business: null }) });
        expect(messages.at(-1)).toMatch(/business.*\?$/);
        expect(messages.join(' ')).toContain('CJ,');
        expect(messages.join(' ')).not.toMatch(/Lara|Business Name:|\p{Extended_Pictographic}/u);
    });
    it('introduces a selected existing sample before the duration question', () => {
        const messages = render({ salesFlow: flow('sample', { durationSeconds: null }), hasSample: true });
        expect(messages[0]).toContain('existing sample'); expect(messages[1]).toMatch(/Ilang seconds.*CJ Bakery\?$/);
    });
    it('does not claim a sample was sent without a verified asset', () => {
        const messages = render({ salesFlow: flow('sample', { durationSeconds: null }) });
        expect(messages[0].toLowerCase()).toContain('wala pa akong verified sample'); expect(messages.at(-1)).toMatch(/seconds.*\?$/);
    });
    it('retains a verified duration supplied before samples', () => expect(render({ salesFlow: flow('sample'), hasSample: true }).at(-1)).toContain('24-second'));
    it('keeps all seven process steps and the revision condition in one message', () => {
        const messages = render({ parts: ['PHP899 ang 24-second video. PHP150 ang down payment, PHP749 ang balance.'], salesFlow: flow('pricing_process') });
        expect(messages).toHaveLength(3);
        expect(messages[0]).toContain('PHP899'); expect(messages[0]).toContain('PHP749');
        const process = messages[1];
        expect(process).toContain('CJ,'); expect(process).toContain('CJ Bakery');
        for (let i = 1; i <= 7; i++) expect(process).toContain('\n' + i + '. ');
        expect(process).toMatch(/PHP150[\s\S]*script[\s\S]*approved[\s\S]*with watermark[\s\S]*final payment[\s\S]*without watermark[\s\S]*FREE poster ads[\s\S]*PHP100[\s\S]*wala sa approved script/);
        expect(messages[2]).toMatch(/mag-proceed.*form\?$/);
    });
    it.each([0, 1, 2, 3])('preserves pricing and process through downstream part cap %s', max_message_parts => {
        const messages = render({ parts: ['PHP899 ang video. PHP150 ang down payment.'], salesFlow: flow('pricing_process') });
        expect(formatChatbotReplyMessages(messages, { split_messages: true, max_message_parts })).toEqual(messages);
        expect(formatChatbotReplyMessages(messages, { split_messages: false, max_message_parts: 1 })).toEqual(messages);
    });
    it('does not cut a complete selected-option pricing message at the old 180/320 character cap', () => {
        const pricing = 'PHP899 ang 24-second video. ' + 'Kasama ang script at voiceover. '.repeat(4) + 'PHP150 ang down payment. PHP749 ang balance. Delivery is according to the confirmed schedule.';
        const messages = render({ parts: [pricing], salesFlow: flow('pricing_process') });
        expect(messages[0]).toContain('confirmed schedule.'); expect(messages[0]).toContain('PHP749');
    });
    it('states that unavailable pricing needs confirmation while keeping the process complete', () => {
        const messages = render({ salesFlow: flow('pricing_process') });
        expect(messages[0]).toContain('i-confirm'); expect(messages[1]).toContain('7. After full payment'); expect(messages.at(-1)).toMatch(/\?$/);
    });
    it('keeps updated pricing and its question intact without repeating an already explained process', () => {
        const messages = render({ parts: ['PHP699 ang 16-second video. PHP150 ang down payment.'], salesFlow: flow('pricing_process', { durationSeconds: 16, processSent: true }) });
        expect(messages).toHaveLength(2);
        expect(messages[0]).toContain('CJ, PRICING PARA SA');
        expect(messages[0]).toContain('16-second');
        expect(messages.join(' ')).not.toContain('STEP-BY-STEP');
        expect(messages.at(-1)).toMatch(/mag-proceed.*\?$/);
        expect(formatChatbotReplyMessages(messages, { split_messages: false, max_message_parts: 1 })).toEqual(messages);
    });
    it('clearly distinguishes a main video from its add-ons and labels reference rates', () => {
        const messages = render({ parts: ['PHP899 for two 8-second videos.'], salesFlow: flow('pricing_process'), pricing: {
            packageName: 'Best Seller', durationSeconds: 24, pricePHP: 899, referenceOnly: true, addonCount: 2, addonDurationSeconds: 8, posters: 1, caption: true
        } });
        expect(messages[0]).toContain('24-second main commercial video');
        expect(messages[0]).toContain('2 add-on videos na tig-8 seconds');
        expect(messages[0]).toContain('reference rate'); expect(messages[0]).toContain('final price at inclusions bago ang payment');
    });
    it('answers a direct process request without sending the form early', () => {
        const messages = render({ salesFlow: flow('duration', { durationSeconds: null, processRequested: true }) });
        expect(messages.filter(m => m.includes('STEP-BY-STEP'))).toHaveLength(1); expect(messages.at(-1)).toContain('seconds');
        expect(messages.some(containsCommercialVideoForm)).toBe(false);
    });
    it('prefills known answers in one complete form, then asks a missing field', () => {
        const messages = render({ details: { 'Business Name': 'CJ Bakery' }, action: 'send_form', salesFlow: flow('form') });
        expect(messages).toHaveLength(2); expect(messages[0]).toContain('CJ,');
        expect(messages[0]).toContain('Kindly fill out these details:\n\nBusiness Name: CJ Bakery\nPage / Social Media Link:\nLocation:\nGoal ng Video:\nPreferred Video Length:\nPreferred Style:\nContact Number:\nPortrait or Landscape?');
        expect(messages[1]).toMatch(/page|social/i); expect(messages[1]).toMatch(/\?$/);
    });
    it('never repeats the form after partial answers', () => {
        const messages = render({ parts: [renderCommercialVideoForm()], details: { 'Business Name': 'CJ Bakery' }, formPreviouslySent: true, salesFlow: flow('form', { formSent: true }) });
        expect(messages.some(containsCommercialVideoForm)).toBe(false); expect(messages).toHaveLength(1); expect(messages[0]).toMatch(/page|social/i);
    });
    it('resends a prefilled form on explicit request', () => expect(render({ details: { 'Business Name': 'CJ Bakery' }, formPreviouslySent: true, salesFlow: flow('form', { formRequested: true }) })[0]).toContain('Business Name: CJ Bakery'));
    it('reopens every field after completion instead of substituting a summary', () => {
        const messages = render({ details: complete, formPreviouslySent: true, salesFlow: flow('complete', { formRequested: true }), action: 'clarify_next_step' });
        expect(messages.filter(containsCommercialVideoForm)).toHaveLength(1);
        expect(messages[0]).toContain(renderCommercialVideoForm(complete));
        expect(messages[0]).not.toContain('Ito ang summary');
        expect(messages.at(-1)).toMatch(/\?$/);
        expect(formatChatbotReplyMessages(messages, { split_messages: true, max_message_parts: 1 })).toEqual(messages);
    });
    it('allows a useful prefilled form reminder without a resend request and explains the free concept', () => {
        const messages = render({ details: { 'Business Name': 'CJ Bakery' }, formPreviouslySent: true, repeatForm: true, salesFlow: flow('form') });
        expect(messages.find(containsCommercialVideoForm)).toContain('free concept');
        expect(messages.find(containsCommercialVideoForm)).toContain('Walang bayad');
        expect(messages.find(containsCommercialVideoForm)).toContain('Business Name: CJ Bakery');
        expect(messages.at(-1)).toMatch(/\?$/);
    });
    it('mentions a no-fee free concept with pricing while keeping paid production separate', () => {
        const messages = render({ parts: ['PHP899 ang paid commercial video.'], salesFlow: flow('pricing_process') });
        expect(messages[0]).toContain('PHP899'); expect(messages[0]).toContain('free concept');
        expect(messages[0]).toContain('walang kailangang bilhin');
    });
    it('rotates ignored missing-field questions and never asks known details', () => {
        const messages = render({ details: { 'Business Name': 'CJ Bakery' }, formPreviouslySent: true, salesFlow: flow('form'), recentMessages: ['Saang city o area ang CJ Bakery?'] });
        expect(messages.at(-1)).toMatch(/page|social/i); expect(messages.at(-1)).not.toMatch(/city|business name/i);
    });
    it('keeps one useful model question for a missing field and removes its duplicate declarative request', () => {
        const messages = render({ parts: ['Anong contact number ang pwede naming gamitin?', 'Please send your contact number.'], details: { ...complete, 'Contact Number': '' }, formPreviouslySent: true, salesFlow: flow('form') });
        expect(messages).toHaveLength(1); expect(messages[0].match(/contact number/g)).toHaveLength(1);
    });
    it.each(['Para saan po ang video?', 'Saan pong mobile number ka pwedeng tawagan?'])('does not mistake a known-field question for a missing location: %s', question => {
        const messages = render({ parts: [question], details: { ...complete, 'Business Location': '' }, formPreviouslySent: true, salesFlow: flow('form') });
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatch(/city|location/i);
        expect(messages[0]).not.toMatch(/para saan|mobile number/i);
    });
    it('shows one complete summary followed by a free next-step question', () => {
        const messages = render({ details: complete, salesFlow: flow('complete'), action: 'clarify_next_step' });
        expect(messages[0].toLowerCase()).toContain(renderCommercialVideoSummary(complete).toLowerCase()); expect(messages[1]).toContain('free concept o free script');
    });
    it('honors free-script handoff with no fee and a relevant final question', () => {
        const messages = render({ details: complete, salesFlow: flow('complete'), action: 'handoff', requestType: 'free_script' });
        expect(messages.join(' ')).toContain('Walang bayad'); expect(messages.join(' ')).not.toContain('Gusto mo ba ng free'); expect(messages.at(-1)).toMatch(/\?$/);
    });
    it('does not repeat unchanged summaries but shows corrections', () => {
        const summary = renderCommercialVideoSummary(complete);
        const args = { details: complete, salesFlow: flow('complete'), recentMessages: [summary], action: 'clarify_next_step' as const };
        expect(render(args).join(' ')).not.toContain('Contact Number:');
        expect(render({ ...args, details: { ...complete, 'Business Location': 'Cebu' } }).join(' ')).toContain('Location: Cebu');
        const delivered = render({ details: complete, salesFlow: flow('complete') });
        expect(render({ ...args, recentMessages: delivered }).join(' ')).not.toContain('Contact Number:');
    });
    it('preserves real customer values including business titles and hyphens', () => {
        const details = { ...complete, 'Business Name': 'Boss CJ Lara Bakery', 'Business Location': 'Quezon-City', 'Goal ng video': 'Promote low-cost bread' };
        const summary = render({ details, salesFlow: flow('complete') })[0];
        expect(summary).toContain('Boss CJ Lara Bakery'); expect(summary).toContain('Quezon-City'); expect(summary).toContain('low-cost');
    });
    it('answers combined paid-price and free-script questions without confusing the fees', () => {
        const messages = render({ parts: ['May free script kami.'], details: {}, customerMessage: 'Magkano ang video at free script?', salesFlow: flow('business', { business: null }), answerRequested: true });
        expect(messages[0]).toContain('final price'); expect(messages[0]).toContain('free script');
    });
});
