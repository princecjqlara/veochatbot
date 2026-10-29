import type { FacebookMessage } from '@/types';
import {
    COMMERCIAL_VIDEO_FIELDS, COMMERCIAL_VIDEO_REQUIRED_DETAILS, extractCommercialVideoFormDetails,
    mergeCommercialVideoChatDetails, normalizeCommercialVideoDetails
} from '@/lib/chatbot-intake';

export const DEFAULT_SALES_FORM_FIELDS = [
    'Business Name', 'Business Industry', 'Product / Service', 'Preferred Style', 'Goal ng video', 'Additional Requests'
];
export type GuidedSalesConfig = { guided_sales_enabled?: boolean; sales_form_fields?: string[] };
const extraAliases: Record<string, string[]> = {
    'Business Industry': ['industry', 'business type', 'business industry', 'industry / business type'],
    'Product / Service': ['product', 'service', 'product or service', 'product / service', 'product or service being advertised'],
    'Additional Requests': ['additional requests', 'additional instructions', 'additional requests or instructions', 'instructions']
};
const key = (text: string) => text.trim().toLowerCase().replace(/[?:]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
const canonical = (label: string) => key(label) === 'main advertising goal' ? 'Goal ng video' : key(label) === 'preferred commercial video style' ? 'Preferred Style' : COMMERCIAL_VIDEO_FIELDS.find(field =>
    [field.key, field.label, field.displayLabel, ...field.aliases].some(alias => key(alias) === key(label)))?.label ||
    Object.keys(extraAliases).find(name => extraAliases[name].some(alias => key(alias) === key(label))) || label.trim();
const useful = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) &&
    !/^(?:unknown|pending|tbd|n\/?a|null|undefined|not (?:provided|specified)|[-?]+)$/i.test(value.trim());

export function normalizeSalesFormFields(value: unknown): string[] {
    if (!Array.isArray(value)) return [...DEFAULT_SALES_FORM_FIELDS];
    return [...new Set(value.filter((label): label is string => typeof label === 'string')
        .map(label => canonical(label.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').slice(0, 80)))
        .filter(label => /^[\p{L}\p{N}]/u.test(label) && !/^(?:constructor|prototype|__proto__)$/i.test(label)))].slice(0, 20);
}

/** Additional sales answers share the existing collected_details JSON record.
 * They never become new handoff requirements. */
export function normalizeGuidedSalesDetails(value: unknown, fields?: string[]): Record<string, string> {
    const result = normalizeCommercialVideoDetails(value);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    const allowed = [...new Set([...DEFAULT_SALES_FORM_FIELDS, ...normalizeSalesFormFields(fields)])];
    for (const [label, answer] of Object.entries(value)) {
        const name = canonical(label);
        if (allowed.includes(name) && !(COMMERCIAL_VIDEO_REQUIRED_DETAILS as readonly string[]).includes(name) && useful(answer)) {
            result[name] = answer.trim().replace(/[\t ]+/g, ' ').slice(0, 500);
        }
    }
    return result;
}

export function extractGuidedSalesForm(text: string, fields?: string[]): Record<string, string> {
    const result: Record<string, string> = extractCommercialVideoFormDetails(text);
    const allowed = [...new Set([...DEFAULT_SALES_FORM_FIELDS, ...normalizeSalesFormFields(fields)])];
    for (const line of text.split(/\r?\n/)) {
        const match = line.replace(/^\s*\d+[.)]\s*/, '').match(/^([^:]{1,80}):\s*(.+)$/);
        if (!match) continue;
        const label = canonical(match[1]);
        if (allowed.includes(label)) result[label] = match[2];
    }
    return normalizeGuidedSalesDetails({ ...result, ...normalizeCommercialVideoDetails(result) }, fields);
}

/** Save only customer-grounded values. A business type is never its proper name. */
export function mergeGuidedSalesDetails(existing: unknown, candidate: unknown, texts: string[], current = '', fields?: string[]) {
    const saved = normalizeGuidedSalesDetails(existing, fields);
    const proposed = normalizeGuidedSalesDetails(candidate, fields);
    const comparable = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const result = { ...saved, ...mergeCommercialVideoChatDetails(saved, proposed, texts, current) };
    for (const [label, answer] of Object.entries(proposed)) {
        if ((COMMERCIAL_VIDEO_REQUIRED_DETAILS as readonly string[]).includes(label)) continue;
        if (texts.some(text => comparable(text).includes(comparable(answer)))) result[label] = answer;
    }
    // Replay explicit form submissions chronologically; blank answers do not erase.
    for (const text of texts) Object.assign(result, extractGuidedSalesForm(text, fields));
    Object.assign(result, extractGuidedSalesForm(current, fields));
    if (!result['Business Industry'] && !/\?|\b(?:not|hindi|wala)\b/i.test(current)) {
        const industry = current.match(/\b(?:milk tea shop|milktea shop|coffee shop|restaurant|bakery|bakeshop|salon|aircon services?|car wash|carwash|real estate|construction|resort|hotel|laundry|dental clinic|clinic|online shop)\b/i)?.[0];
        if (industry && (/\b(?:ako|kami|namin|amin|ko|my|our|own|business|negosyo|may)\b/i.test(current) || current.trim().length < 55)) result['Business Industry'] = industry;
    }
    return result;
}

export function renderGuidedSalesForm(details: unknown, fields?: string[]): string {
    const values = normalizeGuidedSalesDetails(details, fields);
    return 'Optional quick form: pwede rin tayong mag-chat.\n\n' + normalizeSalesFormFields(fields).map(label =>
        (label === 'Goal ng video' ? 'Main Advertising Goal' : label === 'Preferred Style' ? 'Preferred Commercial Video Style' : label) +
        ': ' + (values[label] || '').replace(/\s+/g, ' ')).join('\n');
}
export function containsGuidedSalesForm(text: string) { return text.includes('Optional quick form: pwede rin tayong mag-chat.'); }
export const GUIDED_SALES_INTRO = [
    'Ganito lang kasimple ang process natin:',
    'STEP 1: Share ang business details.',
    'STEP 2: Pili tayo ng bagay na commercial style.',
    'STEP 3: Check ang available samples at verified freebies.',
    'STEP 4: Piliin ang recommended package.',
    '',
    'May optional quick form para mas mabilis, o dito lang tayo mag-chat. Simulan natin sa business mo.'
].join('\n');

export function isNewSalesConversation(input: { history?: FacebookMessage[]; pageId: string; inboundMessage?: string; collectedDetails?: unknown; hasClearRequest?: boolean }) {
    if (input.hasClearRequest || Object.keys(normalizeGuidedSalesDetails(input.collectedDetails)).length) return false;
    const history = input.history || [];
    if (history.some(message => message.from?.id === input.pageId)) return false;
    // Missing/partial history must never make a returning thread restart.
    if (history.length > 1) return false;
    return !history.length || history[0].message?.trim() === input.inboundMessage?.trim();
}

export function guidedSalesPrompt(fields?: string[]) {
    return '\nGUIDED SALES UPDATE (overrides older requirements to fill or resend a form): ' +
        'Preserve the existing Taglish voice, po, no emojis and verified first-name rules. Be confident, helpful and proactive. ' +
        'Offer the quick form once; it is optional. Chat answers and form submissions update the same collected_details. ' +
        'Do not insist on a form or delay useful answers, samples, recommendations or pricing because it was skipped. ' +
        'Collect one missing detail at a time. Connect a verified customer detail to a practical benefit or relevant style recommendation, then one next question. ' +
        'Record industry and product in the customer\'s own words; never invent a business name from its type. ' +
        'Extract these additional configurable fields as well as the existing production details: ' + JSON.stringify(normalizeSalesFormFields(fields)) + '. ' +
        'Use exact customer words for extracted values and corrections, not inferred objectives or identities. ' +
        'Recommend only retrieved available samples and approved package inclusions/freebies. No invented deadlines, guaranteed sales, free custom videos or unsupported promises. ' +
        'Recommend a suitable next action without coercion. A form click, chat choice or completed form is not purchase consent. ' +
        'Do not alter human ownership, assignment, notifications, stop rules or handoff requirements.\n';
}
