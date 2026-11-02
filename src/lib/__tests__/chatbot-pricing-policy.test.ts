import { describe, expect, it } from 'vitest';
import { containsChatbotPrice, withoutChatbotPricing } from '@/lib/chatbot-pricing-policy';

describe('pricing OFF output guard', () => {
    it.each(['PHP899 ang package.', '₱150 down payment.', 'P1,250.50 only.', 'Balance: 749 pesos.',
        'One hundred fifty pesos ang deposit.', 'Limampung piso ang bayad.', '16s: 699', '899 lang po.', 'Revision cost is one hundred.',
        'Ninety ang deposit.', 'Revision cost is sixty.', 'Bayad limandaang.', 'Singkwenta pesos ang revision.'])('blocks %s', text => {
        expect(containsChatbotPrice(text)).toBe(true);
        expect(withoutChatbotPricing([text]).join(' ')).not.toContain(text);
    });
    it('preserves duration, contact details, free concepts and nonfinancial facts', () => {
        const messages = ['24 seconds ang preferred length.', 'Contact Number: 09171234567', 'Walang bayad ang free concept.',
            'Kasama ang script at voiceover. PHP899 ang package.', 'Para sa exact pricing, tutulungan ka ng team.'];
        expect(withoutChatbotPricing(messages)).toEqual([messages[0], messages[1], messages[2], 'Kasama ang script at voiceover.', messages[4]]);
    });
});
