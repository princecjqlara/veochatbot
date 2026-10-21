import { describe, expect, it } from 'vitest';
import { hasRepeatedChatbotCopy, isRepeatedChatbotCopy, splitConversationalCopy, uniqueChatbotCopy } from '@/lib/chatbot-message-copy';
import { renderCommercialVideoForm } from '@/lib/chatbot-intake';

describe('chatbot copy comparison and splitting', () => {
    it('allows repeated forms and sample descriptions while checking their accompanying question and pitch', () => {
        const form = 'Para maihanda ang free concept, pakisagutan ang kulang dito. Walang bayad at walang kailangang bilhin.\n\n' + renderCommercialVideoForm();
        const sample = 'CJ, ito ang existing sample namin para sa bakery.';
        const options = { allowRepeatedFormsAndSamples: true };
        expect(hasRepeatedChatbotCopy([form, sample, 'Anong goal mo sa video?'], [form, sample, 'Saan located ang business?'], options)).toBe(false);
        expect(hasRepeatedChatbotCopy([form, 'Saan po located ang business?'], [form, 'Saan located ang business?'], options)).toBe(true);
        expect(hasRepeatedChatbotCopy([form, 'We can prepare your bakery video.'], ['We can prepare your bakery video.'], options)).toBe(true);
        expect(hasRepeatedChatbotCopy([sample + ' Would you like to proceed?'], [sample, 'Would you like to proceed?'], options)).toBe(true);
        expect(hasRepeatedChatbotCopy([form], [form])).toBe(true);
    });
    it('splits lowercase sentences and single line breaks while preserving decimals and abbreviations', () => {
        expect(splitConversationalCopy('Si Dr. Reyes po ang contact. kasama po ang script.\n699.50 pesos po ang reference.'))
            .toEqual(['Si Dr. Reyes po ang contact.', 'kasama po ang script.', '699.50 pesos po ang reference.']);
    });
    it('detects synonym and paki variants of the same reminder', () => {
        expect(isRepeatedChatbotCopy('Pakisend po ang business location.', 'Kindly provide your business location.')).toBe(true);
        expect(isRepeatedChatbotCopy('Please share your contact number.', 'Send po the contact number please.')).toBe(true);
    });
    it('detects politeness-only and reordered versions of an earlier reminder', () => {
        expect(isRepeatedChatbotCopy('Please send your business location.', 'Send po the business location please!')).toBe(true);
        expect(isRepeatedChatbotCopy('We can prepare a fresh bakery video concept.', 'A fresh bakery video concept we can prepare.')).toBe(true);
    });
    it('keeps updated prices, phone numbers, and negated statements distinct', () => {
        expect(isRepeatedChatbotCopy('The package price is 699 pesos.', 'The package price is 899 pesos.')).toBe(false);
        expect(isRepeatedChatbotCopy('Call the team at 09171234567.', 'Call the team at 09171234568.')).toBe(false);
        expect(isRepeatedChatbotCopy('You do need to pay for this script.', 'You do not need to pay for this script.')).toBe(false);
    });
    it('finds repeated copy across moved bubble breaks and inside a new paragraph', () => {
        expect(hasRepeatedChatbotCopy(['Send your business location please.'], ['We can prepare a bakery video. Please send your business location.'])).toBe(true);
        expect(hasRepeatedChatbotCopy(['We can prepare a bakery video. Send your business location please.'], ['We can prepare a bakery video.', 'Send your business location please.'])).toBe(true);
    });
    it('separates ordinary answers, offers, and questions without splitting decimal prices', () => {
        expect(splitConversationalCopy('The reference rate is 699.50 pesos. Free concept is available.\n\nWhat is your business name?'))
            .toEqual(['The reference rate is 699.50 pesos.', 'Free concept is available.', 'What is your business name?']);
    });
    it('removes near-identical copy within a single reply', () => {
        expect(uniqueChatbotCopy(['Please send your business location.', 'Send po the business location please!', 'What is the goal of the video?']))
            .toEqual(['Please send your business location.', 'What is the goal of the video?']);
    });
});
