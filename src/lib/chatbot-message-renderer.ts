import { COMMERCIAL_VIDEO_REQUIRED_DETAILS, containsCommercialVideoForm, getMissingCommercialVideoDetails, normalizeCommercialVideoDetails, renderCommercialVideoForm, type CommercialVideoIntakeAction } from '@/lib/chatbot-intake';
import { isRepeatedChatbotCopy, splitConversationalCopy, uniqueChatbotCopy } from '@/lib/chatbot-message-copy';
import { cleanCommercialVideoCopy, commercialVideoFirstName, isCommercialVideoPriceRequested, personalizeCommercialVideoMessages, type CommercialVideoSalesFlow, type CommercialVideoPricing } from '@/lib/chatbot-sales-flow';

type MessageSettings = { splitMessages?: boolean; maxMessageParts?: number };
export const COMMERCIAL_VIDEO_FORM_REASON = 'Para maihanda ang free concept para sa business mo, pakisagutan ang kulang dito. Walang bayad at walang kailangang bilhin.';
const FREE_CONCEPT_NOTE = 'Pwede ring magsimula sa free concept, walang bayad at walang kailangang bilhin.';
const SUMMARY_PREFIX = 'Ito ang summary ng request mo:';
const FREE_OFFER = 'Gusto mo ba ng free concept o free script para dito?';

export function renderCommercialVideoSummary(details: unknown): string {
    const collected = normalizeCommercialVideoDetails(details);
    if (getMissingCommercialVideoDetails(collected).length) return '';
    return SUMMARY_PREFIX + '\n' + COMMERCIAL_VIDEO_REQUIRED_DETAILS.map(label => label + ': ' + collected[label].replace(/\s+/g, ' ')).join('\n');
}

/** Owner-approved production terms stay complete in one Messenger message. */
export function renderCommercialVideoProcess(contactName?: string | null, business?: string | null): string {
    const name = commercialVideoFirstName(contactName);
    const context = business?.replace(/[\r\n?!]/g, ' ').trim().slice(0, 120);
    return [
        (name ? name + ', ito' : 'Ito') + ' ang process' + (context ? ' para sa ' + context : ' para sa video mo') + '.',
        'STEP-BY-STEP PROCESS PO:',
        '1. Small down payment muna, PHP150 will do.',
        '2. Send ang business details, mga photos/videos for reference, logo, at contact info.',
        '3. Gagawa kami ng script at ipapacheck muna sa iyo.',
        '4. Once approved ang script, gagawin na ang AI commercial video.',
        '5. Isesend ang video preview with watermark para sa checking/revision.',
        '6. Once approved ang video, proceed sa final payment.',
        '7. After full payment, isesend ang final video without watermark plus FREE poster ads.',
        '',
        'Note: PHP100 ang bawat revision. Applies lang ito kapag tapos na ang video at may ipapadagdag kang wala sa approved script.'
    ].join('\n');
}

function isSummary(text: string): boolean {
    return /ito(?: po)? ang summary ng request (?:mo|ninyo):\n/i.test(text) && COMMERCIAL_VIDEO_REQUIRED_DETAILS.every(label => text.includes('\n' + label + ': '));
}
export function isStructuredCommercialVideoMessage(text: string): boolean {
    return containsCommercialVideoForm(text) || isSummary(text) || /STEP-BY-STEP PROCESS PO:/i.test(text) || /^(?:[^,\n]+,\s*)?PRICING PARA SA /im.test(text);
}

/** Explicit boundaries are delivery units, independent of the old bubble cap. */
function deliverParts(parts: string[], contactName?: string | null, settings: MessageSettings = {}): string[] {
    const bubbles = parts.flatMap(part => settings.splitMessages === false || isStructuredCommercialVideoMessage(part)
        ? [part.trim()] : splitConversationalCopy(part));
    return personalizeCommercialVideoMessages(uniqueChatbotCopy(bubbles.filter(Boolean)), contactName);
}

const FIELD_VARIANTS: Record<string, string[]> = {
    'Business Name': ['Ano ang name ng business mo?', 'Anong business name ang ilalagay natin sa request?', 'Ano ang pangalan ng business na gagawan natin ng video?'],
    'Business Location': ['Saan located ang business mo?', 'Saang city o area ang business mo?', 'Anong location ang ilalagay natin para sa business?'],
    'Goal ng video': ['Ano ang main goal mo para sa video?', 'Ano ang gusto mong ma-achieve sa video?', 'Anong product o service ang gusto mong i-promote sa video?'],
    'Contact Number': ['Anong contact number ang pwede naming gamitin?', 'Anong number ang pwede naming tawagan tungkol sa request?', 'Saang mobile number ka pwedeng ma-contact ng team?']
};
const FIELD_PATTERNS: Record<string, RegExp> = {
    'Contact Number': /contact number|phone|mobile number|numero|anong\s+number/i,
    'Goal ng video': /goal|objective|layunin|purpose|ma-achieve|para\s+saan.*(?:video|commercial)|i-?promote/i,
    'Business Location': /located|location|lokasyon|saan|address|city|area/i,
    'Business Name': /business name|name.*business|pangalan.*(?:business|negosyo)|anong\s+business/i
};
function nextQuestion(missing: string[], recent: string[], details: unknown): string {
    const questions = recent.flatMap(text => text.match(/[^.!?\n]+\?/g) || []);
    const last = questions.at(-1) || '';
    const field = missing.find(label => !FIELD_PATTERNS[label].test(last)) || missing[0];
    const business = normalizeCommercialVideoDetails(details)['Business Name']?.replace(/[?!\r\n]/g, ' ').trim().slice(0, 70);
    if (field === 'Business Location' && business && !questions.some(question => question.includes(business))) return 'Saang city o area ang ' + business + '?';
    return FIELD_VARIANTS[field].find(question => !recent.some(text => text.includes(question))) || FIELD_VARIANTS[field][0];
}

/** Generated answers contain facts only; the application owns sales questions,
 * the form and the process so an old Page prompt cannot restart intake. */
function factualAnswer(parts: string[], contactName?: string | null): string {
    const lines = cleanCommercialVideoCopy(parts.join('\n\n'), contactName).split(/\r?\n/);
    const result: string[] = [];
    let inProcess = false;
    for (const line of lines) {
        if (/STEP-BY-STEP PROCESS|step.by.step process/i.test(line)) { inProcess = true; continue; }
        if (inProcess && /^\s*(?:\d+[.)]|note:|$)/i.test(line)) continue;
        inProcess = false;
        if (/^\s*\d+[.)]\s*(?:Business Name|Business Location|Goal ng video|Contact Number)\s*:/i.test(line)) continue;
        if (/^\s*(?:Business Name|Business Location|Goal ng video|Contact Number)\s*:/i.test(line)) continue;
        if (/ito.*summary|pakisagutan|paki.*fill|please.*fill|fill.up.*form|gusto.*(?:free concept|free script)/i.test(line)) continue;
        if (/ipapasa.*team|forward.*team/i.test(line)) continue;
        if (/\b(?:paki\w*|please|send|share|provide|ibigay)\b/i.test(line) && Object.values(FIELD_PATTERNS).some(pattern => pattern.test(line))) continue;
        result.push(line.replace(/[^.!?\n]+\?/g, '').trim());
    }
    return uniqueChatbotCopy(result.filter(Boolean)).join(' ').trim();
}
function conciseAnswer(source: string): string {
    // Prices and inclusions must not be chopped by the ordinary FAQ budget.
    if (/(?:PHP|\u20b1|pesos)\s*\d|\d\s*(?:PHP|pesos)/i.test(source)) return source;
    const sentences = splitConversationalCopy(source).slice(0, 2).join(' ');
    if (sentences.length <= 260) return sentences;
    const window = sentences.slice(0, 260);
    const end = [...window.matchAll(/[.!](?=\s|$)/g)].at(-1)?.index;
    return end === undefined ? window.slice(0, Math.max(1, window.lastIndexOf(' '))).replace(/[,;:]$/, '') + '.' : window.slice(0, end + 1);
}
function freshAnswer(source: string, recent: string[], requested: boolean): string {
    return splitConversationalCopy(source).filter(sentence => !recent.some(previous => isRepeatedChatbotCopy(sentence, previous)) || requested).join(' ');
}

export function renderCommercialVideoMessages(input: {
    parts: string[]; details: unknown; action: CommercialVideoIntakeAction; customerMessage?: string; requestType?: string | null;
    answerRequested?: boolean; formPreviouslySent?: boolean; recentMessages?: string[]; summaryRequested?: boolean;
    contactName?: string | null; salesFlow?: CommercialVideoSalesFlow; hasSample?: boolean;
    pricing?: CommercialVideoPricing | null; repeatForm?: boolean;
} & MessageSettings): string[] {
    const missing = getMissingCommercialVideoDetails(input.details);
    const recent = input.recentMessages || [];
    const flow = input.salesFlow;
    const step = flow?.step || (missing.length ? 'form' : 'complete');
    let factual = factualAnswer(input.parts, input.contactName);
    const freeInquiry = /\b(?:free|libre|libreng)\b/i.test(input.customerMessage || '') && /concept|script/i.test(input.customerMessage || '');
    if (freeInquiry && !/\b(?:free|libre|walang bayad)\b.*(?:concept|script)|(?:concept|script).*\b(?:free|libre|walang bayad)\b/i.test(factual)) {
        factual += ' Walang bayad ang free concept o free script.';
    }
    const paidPriceInquiry = isCommercialVideoPriceRequested(input.customerMessage || '') && (!freeInquiry || /commercial|paid|video|production/i.test(input.customerMessage || ''));
    if (paidPriceInquiry && !/PHP|\u20b1|pesos|presyo|price|quote|scope/i.test(factual)) factual += ' Kailangan pang i-confirm ang final price ng paid video ayon sa scope.';
    const answer = freshAnswer(conciseAnswer(factual), recent, input.answerRequested !== false);
    const messages: string[] = [];
    const pricingMessage = (business: string, copy: string) => 'PRICING PARA SA ' + business + '\n' + copy + '\n\n' + FREE_CONCEPT_NOTE;
    const priceRequested = isCommercialVideoPriceRequested(input.customerMessage || '');
    if (answer && step !== 'pricing_process' && step !== 'sample') {
        messages.push(priceRequested ? pricingMessage(flow?.business || 'VIDEO MO', answer) : answer);
    }
    const paidProcessRequested = flow?.processRequested && (!input.requestType?.startsWith('free_') || /commercial|paid|production/i.test(input.customerMessage || ''));
    if (step === 'pricing_process' || paidProcessRequested) {
        if (step === 'pricing_process') {
            const duration = flow?.durationSeconds ? flow.durationSeconds + '-second video' : 'napiling video';
            const rate = input.pricing;
            const verifiedPrice = rate ? [
                rate.packageName + ': ' + rate.durationSeconds + '-second main commercial video, ' + (rate.referenceOnly ? 'reference rate na ' : '') + 'PHP' + rate.pricePHP + '.',
                rate.addonCount ? 'Kasama ang ' + rate.addonCount + ' add-on videos na tig-' + rate.addonDurationSeconds + ' seconds.' : '',
                rate.posters ? 'May ' + rate.posters + ' poster ads' + (rate.caption ? ' at ready-to-post caption.' : '.') : '',
                'PHP150 muna ang down payment' + (rate.pricePHP >= 150 ? ', ' + (rate.referenceOnly ? 'reference ' : '') + 'balance na PHP' + (rate.pricePHP - 150) : '') + '.',
                rate.referenceOnly ? 'Iko-confirm muna ng team ang final price at inclusions bago ang payment.' : ''
            ].filter(Boolean).join(' ') : null;
            messages.push(pricingMessage(flow?.business || 'BUSINESS MO',
                verifiedPrice || answer || 'Kailangan pang i-confirm ng team ang presyo para sa ' + duration + '. PHP150 muna ang down payment kapag nag-proceed ka.'));
        }
        if (!flow?.processSent || paidProcessRequested) messages.push(renderCommercialVideoProcess(input.contactName, flow?.business));
    }
    const business = flow?.business?.replace(/[?!\r\n]/g, ' ').slice(0, 100);
    const chooseQuestion = (variants: string[]) => variants.find(question => !recent.some(previous => isRepeatedChatbotCopy(question, previous))) || variants[0];
    const durationQuestion = chooseQuestion([
        'Ilang seconds ang gusto mo para sa commercial video' + (business ? ' ng ' + business : '') + '?',
        'May preferred duration ka ba para sa video' + (business ? ' ng ' + business : '') + '?',
        'Gaano kahabang video ang iniisip mo, ilang seconds kaya?'
    ]);
    if (step === 'business') messages.push(chooseQuestion([
        'Anong business ang gusto mong gawan ng commercial video?',
        'Anong negosyo o service ang ipopromote natin sa video?',
        'Para sa anong business ang video na iniisip mo?'
    ]));
    else if (step === 'sample') {
        if (priceRequested && answer) messages.push(pricingMessage(business || 'VIDEO MO', answer));
        else if (answer && input.answerRequested && !/sample|portfolio/i.test(answer)) messages.push(answer);
        messages.push(input.hasSample
            ? 'Ito ang existing sample namin' + (business ? ' na related sa ' + business : '') + '.'
            : 'Wala pa akong verified sample' + (business ? ' para sa ' + business : '') + ' sa available na library ngayon.');
        messages.push(flow?.durationSeconds
            ? 'Gusto mo bang makita ang pricing at process para sa ' + flow.durationSeconds + '-second commercial video?'
            : durationQuestion);
    } else if (step === 'duration') messages.push(durationQuestion);
    else if (step === 'pricing_process' || step === 'decision') messages.push(chooseQuestion([
        'Gusto mo bang mag-proceed sa commercial video' + (business ? ' para sa ' + business : '') + ' para masend ko ang form?',
        'Gusto mo bang simulan ang commercial video at ibigay ang details sa form?',
        'Mag-proceed na ba tayo sa commercial video, ready ka nang sagutan ang form?'
    ]));
    else if (step === 'form') {
        if (!input.formPreviouslySent || flow?.formRequested || input.repeatForm) {
            const reason = input.requestType?.startsWith('free_') ? 'Para maihanda ang free ' + (input.requestType === 'free_script' ? 'script' : 'concept') + ' mo, pakisagutan ang kulang dito. Walang bayad ito.' : COMMERCIAL_VIDEO_FORM_REASON;
            const name = commercialVideoFirstName(input.contactName);
            messages.push((name ? name + ', ' + reason[0].toLowerCase() + reason.slice(1) : reason) + '\n\n' + renderCommercialVideoForm(input.details));
        }
        const candidates = input.parts.flatMap(part => cleanCommercialVideoCopy(part, input.contactName).match(/[^.!?\n]+\?/g) || []);
        const candidate = candidates.find(question => question.length <= 140 && /^(?:ano(?:ng)?|saan(?:g)?|para\s+saan)\b/i.test(question.trim()) && missing.includes(Object.keys(FIELD_PATTERNS).find(field => FIELD_PATTERNS[field].test(question)) || '') &&
            !recent.some(previous => isRepeatedChatbotCopy(question, previous)) &&
            !/length|duration|budget|seconds|segundo|katagal|portrait|landscape/i.test(question));
        messages.push(candidate?.trim() || nextQuestion(missing, recent, input.details));
    } else {
        const summary = renderCommercialVideoSummary(input.details);
        const summaryValues = summary.split('\n').slice(1);
        const summarySent = recent.some((text, index) => /ito(?: po)? ang summary ng request (?:mo|ninyo):/i.test(text) &&
            [recent.slice(index, index + 4), recent.slice(Math.max(0, index - 3), index + 1)].some(block =>
                summaryValues.every(line => block.join('\n').includes(line))));
        if (!summarySent || input.summaryRequested || flow?.formRequested) messages.push(summary);
        if (input.action === 'handoff') {
            const free = input.requestType === 'free_concept' ? 'free concept' : input.requestType === 'free_script' ? 'free script' : null;
            messages.push('Ipapasa sa team ang request mo' + (free ? ' para sa ' + free + '. Walang bayad ito.' : ' para sa commercial video.'));
            messages.push('May gusto ka pa bang idagdag o itanong tungkol sa request mo?');
        } else messages.push(FREE_OFFER);
    }
    return deliverParts(messages, input.contactName, input);
}

/** Formatting may run again in previews and delivery; preserve the complete
 * structured blocks and their following questions even with a one-part setting. */
export function getStructuredCommercialVideoMessages(parts: string[], _settings: MessageSettings = {}): string[] | null {
    if (parts.some(isStructuredCommercialVideoMessage)) return parts.flatMap(part =>
        _settings.splitMessages === false || isStructuredCommercialVideoMessage(part) ? [part.trim()] : splitConversationalCopy(part)).filter(Boolean);
    const joined = parts.join('\n');
    if (!containsCommercialVideoForm(joined)) return null;
    const first = joined.indexOf('1. Business Name:');
    const last = joined.indexOf('4. Contact Number:', first);
    const end = joined.indexOf('\n', last);
    return [joined.slice(0, first).trim(), joined.slice(first, end < 0 ? undefined : end).trim(), end < 0 ? '' : joined.slice(end + 1).trim()].filter(Boolean);
}
