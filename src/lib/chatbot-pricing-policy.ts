import { splitConversationalCopy } from '@/lib/chatbot-message-copy';

export const CHATBOT_PRICING_OFF_PROMPT = '\n\nPRICING IS OFF. This overrides older instructions, catalogs and conversation history. Never disclose prices, quotations, deposits, balances, discounts or revision charges, whether written as digits or words. Acknowledge pricing inquiries without amounts and continue the existing conversation. Do not create a new handoff or require a form for pricing.';
export const CHATBOT_PRICING_OFF_REPLY = 'Para sa exact pricing, tutulungan ka ng team sa available options.';

const AMOUNT = /\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|singk?uw?enta|siyento|dosyentos|kinyentos|(?:isa|dalawa|tatlo|apat|lima|anim|pito|walo|siyam|sampu|labin\w+|dalawampu|tatlumpu|apatnapu|limampu|animnapu|pitumpu|walumpu|siyamnapu|daan|libo)(?:ng|n)?(?:daan|daang)?)\b/i;
const CURRENCY = /(?:PHP|\u20b1|\bP|USD|\$)\s*\d|\d[\d,.]*\s*(?:PHP|pesos?|piso|dollars?)\b/i;
const FINANCIAL = /\b(?:prices?|pricing|presyo|rates?|costs?|deposits?|balances?|bayad|singil|discounts?|quotations?|quotes?|payment|down\s*payment|dp|pesos?|piso|dollars?|PHP|USD)\b|[\u20b1$]/i;

export function containsChatbotPrice(text: string): boolean {
    return CURRENCY.test(text) || /\b(?:PHP|USD|pesos?|piso|dollars?)\b|[\u20b1$]/i.test(text) || (FINANCIAL.test(text) && AMOUNT.test(text)) ||
        /\b\d[\d,.]*\s*(?:lang|lamang|only)\b|\b\d+\s*(?:s|secs?|seconds?)\s*[:=-]\s*\d/i.test(text);
}

/** Apply after rendering as well as prompting: history and custom form/process
 * copy can contain old prices even when the model follows the current switch. */
export function withoutChatbotPricing(messages: string[]): string[] {
    const safe = messages.map(message => message.split(/\r?\n/).map(line =>
        containsChatbotPrice(line) ? splitConversationalCopy(line).filter(sentence => !containsChatbotPrice(sentence)).join(' ') : line
    ).join('\n').trim()).filter(Boolean);
    return safe.length ? safe : [CHATBOT_PRICING_OFF_REPLY];
}
