import { describe, expect, it } from 'vitest';
import { commercialVideoFirstName, cleanCommercialVideoCopy, getCommercialVideoPricing, resolveCommercialVideoSalesFlow } from '@/lib/chatbot-sales-flow';
import { renderCommercialVideoForm } from '@/lib/chatbot-intake';
import { renderCommercialVideoProcess } from '@/lib/chatbot-message-renderer';
import type { FacebookMessage } from '@/types';
const turn = (message: string, role = 'customer', second = 0): FacebookMessage => ({ id: role + second, message, from: { id: role, name: role }, created_time: '2026-10-21T10:00:' + String(second).padStart(2, '0') + 'Z' });
const resolve = (history: FacebookMessage[], extra = {}) => resolveCommercialVideoSalesFlow({ pageId: 'page', history, ...extra });
const discovery = [turn('Anong business ang gusto mong gawan ng commercial video?', 'page'), turn('Bakery po', 'customer', 1)];
const sampled = [...discovery, turn('Ito ang existing sample namin na related sa bakery.', 'page', 2), turn('Ilang seconds ang gusto mo?', 'page', 3)];

describe('history-based commercial-video sales flow', () => {
    it('asks the business before sending any form', () => expect(resolve([turn('Hi')]).step).toBe('business'));
    it('moves from a business answer to a relevant existing sample', () => expect(resolve(discovery)).toMatchObject({ step: 'sample', business: 'Bakery', sampleSent: false }));
    it('recognizes a business in an opening question', () => expect(resolve([turn('Magkano sa dental clinic video?')]).step).toBe('sample'));
    it('remembers arbitrary niches supplied in response to the business question', () => expect(resolve([discovery[0], turn('Custom boat repair', 'customer', 1)]).business).toBe('Custom boat repair'));
    it('accepts model niche context only when quoted from a real customer message', () => {
        expect(resolve([turn('Custom boat repair')], { businessType: 'boat repair' }).step).toBe('sample');
        expect(resolve([turn('Hi')], { businessType: 'boat repair' }).step).toBe('business');
    });
    it('asks duration after a sample, never the form fields', () => expect(resolve(sampled).step).toBe('duration'));
    it.each(['24 seconds', '24s', '24', '24 po'])('uses a customer duration answer %s', answer => expect(resolve([...sampled, turn(answer, 'customer', 4)])).toMatchObject({ step: 'pricing_process', durationSeconds: 24 })) ;
    it.each(['24-second video', '24 segundos po'])('recognizes a supplied duration without asking again: %s', answer => expect(resolve([...sampled, turn(answer, 'customer', 4)]).durationSeconds).toBe(24));
    it('supports minute durations without interpreting phone numbers as seconds', () => {
        expect(resolve([...sampled, turn('1 minute', 'customer', 4)]).durationSeconds).toBe(60);
        expect(resolve([...sampled, turn('09171234567', 'customer', 4)]).durationSeconds).toBeNull();
    });
    it('never uses a Page sample duration as the customer selection', () => expect(resolve([...sampled, turn('Our sample is 30 seconds.', 'page', 4)]).durationSeconds).toBeNull());
    it('does not treat an offered or requested sample as already sent', () => expect(resolve([...discovery, turn('Gusto mo ba ng sample?', 'page', 2)]).sampleSent).toBe(false));
    it('continues honestly when no matching sample is available', () => expect(resolve([...discovery, turn('Wala pa akong verified sample para sa bakery sa available na library ngayon.', 'page', 2), turn('30 seconds', 'customer', 3)])).toMatchObject({ step: 'pricing_process', sampleSent: false, sampleHandled: true }));
    it('asks for a buying decision after sending the process', () => expect(resolve([...sampled, turn('24 seconds', 'customer', 4), turn('PRICING PARA SA bakery\n24-second main commercial video: PHP899.', 'page', 5), turn(renderCommercialVideoProcess(), 'page', 6)]).step).toBe('decision'));
    it('moves to the form only after a clear request at the buying step', () => expect(resolve([...sampled, turn('24 seconds', 'customer', 4), turn('PRICING PARA SA bakery\n24-second main commercial video: PHP899.', 'page', 5), turn(renderCommercialVideoProcess(), 'page', 6)], { hasClearRequest: true, requestType: 'commercial_video' }).step).toBe('form'));
    it('still sends pricing when the process was requested before the duration', () => expect(resolve([...sampled,
        turn(renderCommercialVideoProcess(), 'page', 4), turn('24 seconds', 'customer', 5)]).step).toBe('pricing_process'));
    it('updates pricing when the customer changes duration after the first quote', () => expect(resolve([...sampled,
        turn('24 seconds', 'customer', 4), turn('PRICING PARA SA bakery\n24-second main commercial video: PHP899.', 'page', 5),
        turn(renderCommercialVideoProcess(), 'page', 6), turn('16 seconds', 'customer', 7)])).toMatchObject({ step: 'pricing_process', durationSeconds: 16 }));
    it('applies a latest duration even when the same answer appeared earlier in history', () => expect(resolve([...sampled,
        turn('16 seconds', 'customer', 4), turn('PRICING PARA SA bakery\n16-second main commercial video: PHP699.', 'page', 5),
        turn('24 seconds', 'customer', 6), turn('PRICING PARA SA bakery\n24-second main commercial video: PHP899.', 'page', 7),
        turn(renderCommercialVideoProcess(), 'page', 8)], { inboundMessage: '16 seconds' })).toMatchObject({ durationSeconds: 16, step: 'pricing_process' }));
    it('honors explicit form and free-script requests immediately', () => {
        expect(resolve([turn('Pakisend ng form')]).step).toBe('form');
        expect(resolve([turn('Free script please')], { hasClearRequest: true, requestType: 'free_script' }).step).toBe('form');
    });
    it('continues existing intake without restarting the sales flow', () => expect(resolve([turn(renderCommercialVideoForm(), 'page'), turn('Manila', 'customer', 1)], { details: { 'Business Location': 'Manila' } }).step).toBe('form'));
    it('does not confuse a business type with its actual name', () => expect(resolve(discovery).business).toBe('Bakery'));
});

describe('selected-duration pricing from the existing knowledge', () => {
    const knowledge = [{ document_id: 'prices', chunk_id: 'prices-1', title: 'Current knowledge', similarity: 1,
        content: 'Historical reference price\n| Starter Pack | 16 seconds | PHP699 | 1 x 8 seconds | 1 | Included |\n| Best Seller | 24 seconds | PHP899 | 2 x 8 seconds | 1 | Included |\n| Brand Level | 1 minute | PHP1,499 | 3 x 8 seconds | 3 | Included |' }];
    it('keeps the main duration, short add-ons and reference status separate', () => expect(getCommercialVideoPricing(knowledge, 24)).toEqual({
        packageName: 'Best Seller', durationSeconds: 24, pricePHP: 899, referenceOnly: true, addonCount: 2, addonDurationSeconds: 8, posters: 1, caption: true
    }));
    it('parses minute durations and thousands separators', () => expect(getCommercialVideoPricing(knowledge, 60)?.pricePHP).toBe(1499));
    it('does not invent a package for an unsupported duration', () => expect(getCommercialVideoPricing(knowledge, 30)).toBeNull());
});

describe('first-name and emoji cleanup', () => {
    it.each([['CJ Lara', 'CJ'], ['Dr. Maria Santos', 'Maria'], ['Anne-Marie Cruz', 'Anne-Marie'], ['Unknown User', null], ['Customer', null], ['', null]])('uses only the reliable first name from %s', (name, expected) => expect(commercialVideoFirstName(name)).toBe(expected));
    it('removes emoji sequences, flags and honorifics without damaging amounts or URLs', () => expect(cleanCommercialVideoCopy('Sir CJ Lara, hello \u{1F44B}\u{1F3FB} \u{1F1F5}\u{1F1ED} PHP150 https://example.com/my-video', 'CJ Lara')).toBe('CJ, hello PHP150 https://example.com/my-video'));
    it('preserves a real business name containing the profile name in the process context', () => expect(cleanCommercialVideoCopy('CJ, ito ang process para sa CJ Lara Bakery.', 'CJ Lara')).toBe('CJ, ito ang process para sa CJ Lara Bakery.'));
    it('preserves customer business names in structured values', () => expect(cleanCommercialVideoCopy('1. Business Name: Boss CJ Lara Bakery', 'CJ Lara')).toBe('1. Business Name: Boss CJ Lara Bakery'));
    it('removes decorative emojis from structured output without changing stored field identities', () => expect(cleanCommercialVideoCopy('1. Business Name: Boss Bakery \u{1F35E}', 'CJ Lara')).toBe('1. Business Name: Boss Bakery'));
    it('uses the known first name if a draft greets only the surname', () => expect(cleanCommercialVideoCopy('Hi Lara, pwede po.', 'CJ Lara')).toBe('Hi CJ, pwede po.'));
});
