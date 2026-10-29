import type { FacebookMessage } from '@/types';
import type { ChatbotKnowledgeMatch } from '@/lib/chatbot-knowledge';
import { normalizeCommercialVideoDetails, extractCommercialVideoFormDetails, commercialVideoDurationSeconds } from '@/lib/chatbot-intake';
import { normalizeCollectedChatbotDetails } from '@/lib/chatbot-control';
import { cleanCommercialVideoCopy, getCommercialVideoPriceList, isCommercialVideoPriceRequested, type CommercialVideoPricing } from '@/lib/chatbot-sales-flow';
import { renderCommercialVideoPriceList, getCommercialVideoNextQuestion } from '@/lib/chatbot-message-renderer';

export type SalesField = { label: string; question: string; required: boolean; enabled: boolean };
export type SalesSample = { document_id: string; industry: string; product_category: string; style: string; description: string; active: boolean };
export type SalesSettings = {
    pricing_enabled: boolean; introduction: string; process_steps: string[]; fields: SalesField[];
    samples: SalesSample[]; industry_mappings: Record<string, string>; aggressiveness: 'gentle' | 'confident' | 'direct';
    max_follow_ups: number; collection_enabled: boolean;
};
export type SalesProgress = {
    introduction_pending?: boolean;
    stage?: string; temperature?: 'hot' | 'warm' | 'cold'; introduced_at?: string; form_offered_at?: string;
    pricing_inquiry?: boolean; last_question?: string; samples_sent?: string[]; freebies_presented?: string[];
    recommended_samples?: string[]; form_submitted_at?: string; assumptions?: Record<string, string>;
    field_sources?: Record<string, { source: string; observed_at: string; confirmed: boolean }>;
};
type SalesConfig = { commercial_video_intake_enabled?: boolean; sales_assistant_settings?: unknown };
export const DEFAULT_SALES_FIELDS: SalesField[] = [
    { label: 'Business Name', question: 'Ano ang pangalan ng business mo?', required: true, enabled: true },
    { label: 'Business Industry', question: 'Anong business o industry ang meron ka?', required: true, enabled: true },
    { label: 'Product or Service', question: 'Anong product o service ang gusto nating i-feature?', required: true, enabled: true },
    { label: 'Preferred Style', question: 'Anong style ang gusto mo, realistic, cinematic, o animated?', required: true, enabled: true },
    { label: 'Goal ng video', question: 'Ano ang main goal mo para sa video?', required: true, enabled: true },
    { label: 'Additional Instructions', question: 'May additional requests ka ba para sa commercial?', required: false, enabled: true }
];
export const DEFAULT_SALES_SETTINGS: SalesSettings = {
    pricing_enabled: false, introduction: 'Hello po! Ganito lang kasimple ang process natin:',
    process_steps: ['Share your business details', 'Choose your preferred commercial style', 'Check relevant samples and available inclusions', 'Get your recommended package'],
    fields: DEFAULT_SALES_FIELDS, samples: [], aggressiveness: 'confident', collection_enabled: true, max_follow_ups: 10,
    industry_mappings: { restaurant: 'Food & Beverage', 'milk tea': 'Food & Beverage', milktea: 'Food & Beverage', bakery: 'Food & Beverage',
        'real estate': 'Real Estate', construction: 'Construction', automotive: 'Automotive', hotel: 'Hotels & Resorts', resort: 'Hotels & Resorts',
        retail: 'Retail', hardware: 'Retail', clinic: 'Healthcare', dental: 'Healthcare' }
};

/** The additive migration opts existing commercial Pages into the new guidance.
 * Unmigrated installations retain their previous behavior. */
export function usesSalesAssistant(config: SalesConfig): boolean {
    return config.commercial_video_intake_enabled === true && !!config.sales_assistant_settings && typeof config.sales_assistant_settings === 'object';
}
export function salesSettings(value: unknown): SalesSettings {
    const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<SalesSettings> : {};
    return { ...DEFAULT_SALES_SETTINGS, ...raw, pricing_enabled: raw.pricing_enabled === true,
        fields: raw.fields || DEFAULT_SALES_FIELDS, process_steps: raw.process_steps || DEFAULT_SALES_SETTINGS.process_steps,
        samples: raw.samples || [], industry_mappings: raw.industry_mappings || DEFAULT_SALES_SETTINGS.industry_mappings };
}
export function chatbotPricingEnabled(config: SalesConfig): boolean {
    return !usesSalesAssistant(config) || salesSettings(config.sales_assistant_settings).pricing_enabled;
}
export function approvedSalesRates(knowledge: ChatbotKnowledgeMatch[]): CommercialVideoPricing[] {
    return getCommercialVideoPriceList(knowledge.filter(source => source.contact_pricing_catalog || /current owner-approved promo catalog|owner-approved promo price list/i.test(source.content)))
        .filter(rate => !rate.referenceOnly).map(rate => ({ ...rate, ownerVerifiedCatalog: true }));
}
export function validateSalesSettings(value: unknown): SalesSettings {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Sales settings must be an object');
    const raw = value as Record<string, unknown>;
    if (raw.pricing_enabled !== undefined && typeof raw.pricing_enabled !== 'boolean') throw new Error('Pricing must be ON or OFF');
    const settings = salesSettings(value);
    const text = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
    if (typeof settings.pricing_enabled !== 'boolean' || typeof settings.collection_enabled !== 'boolean' ||
        !text(settings.introduction, 1000) || !['gentle', 'confident', 'direct'].includes(settings.aggressiveness) ||
        !Number.isInteger(settings.max_follow_ups) || settings.max_follow_ups < 0 || settings.max_follow_ups > 30) throw new Error('Invalid sales behavior settings');
    if (!Array.isArray(settings.process_steps) || !settings.process_steps.length || settings.process_steps.length > 10 || settings.process_steps.some(step => !text(step, 240))) throw new Error('Provide 1–10 process steps');
    if (!Array.isArray(settings.fields) || !settings.fields.length || settings.fields.length > 20 || settings.fields.some(field =>
        !text(field.label, 80) || !text(field.question, 200) || typeof field.required !== 'boolean' || typeof field.enabled !== 'boolean' || /[\r\n:]/.test(field.label))) throw new Error('Invalid form fields');
    const labels = settings.fields.map(field => field.label.toLowerCase());
    if (new Set(labels).size !== labels.length || labels.some(label => ['__proto__', 'constructor', 'prototype'].includes(label))) throw new Error('Form labels must be unique');
    if (!Array.isArray(settings.samples) || settings.samples.length > 100 || settings.samples.some(sample =>
        !/^[0-9a-f-]{36}$/i.test(sample.document_id) || typeof sample.active !== 'boolean' ||
        [sample.industry, sample.product_category, sample.style].some(v => typeof v !== 'string' || v.length > 100) || !text(sample.description, 500))) throw new Error('Invalid sample assignments');
    if (!settings.industry_mappings || typeof settings.industry_mappings !== 'object' || Array.isArray(settings.industry_mappings) || Object.keys(settings.industry_mappings).length > 100 ||
        Object.entries(settings.industry_mappings).some(([key, val]) => !text(key, 80) || !text(val, 100))) throw new Error('Invalid industry mappings');
    return settings;
}

const comparable = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function positiveEvidence(text: string, answer: string): boolean {
    const source = comparable(text), value = comparable(answer);
    const index = source.indexOf(value);
    return !!value && index >= 0 && !/\b(?:not|hindi|ayaw|no)(?:\s+\w+){0,2}\s*$/.test(source.slice(Math.max(0, index - 25), index));
}
const knownStyle = /\b(realistic|cinematic|animated|animation|3d|cartoon)\b/i;
export function normalizeSalesDetails(value: unknown, settings: SalesSettings): Record<string, string> {
    const plain = normalizeCollectedChatbotDetails(value);
    const canonical = normalizeCommercialVideoDetails(value);
    const aliases: Record<string, string> = { industry: 'Business Industry', product: 'Product or Service', 'product / service': 'Product or Service', 'product or service being advertised': 'Product or Service', 'additional requests': 'Additional Instructions',
        'main advertising goal': 'Goal ng video', 'advertising goal': 'Goal ng video', 'preferred commercial video style': 'Preferred Style', 'additional requests or instructions': 'Additional Instructions' };
    for (const [key, val] of Object.entries(plain)) {
        const label = aliases[key.toLowerCase()] || settings.fields.find(field => field.label.toLowerCase() === key.toLowerCase())?.label;
        if (label && !canonical[label]) canonical[label] = val;
    }
    return canonical;
}

/** Model proposals need customer evidence. Only the latest customer turn may
 * correct a saved answer; a stale extraction cannot undo a submitted form. */
export function mergeSalesChatDetails(existing: unknown, candidate: unknown, texts: string[], current: string, settings: SalesSettings, lastQuestion = '') {
    const saved = normalizeSalesDetails(existing, settings);
    const proposed = normalizeSalesDetails(candidate, settings);
    for (const [label, answer] of Object.entries(proposed)) {
        const evidence = comparable(answer);
        if (evidence && (saved[label] ? positiveEvidence(current, answer) : texts.some(text => positiveEvidence(text, answer)))) saved[label] = answer;
    }
    Object.assign(saved, normalizeSalesDetails(extractCommercialVideoFormDetails(current), settings));
    for (const field of settings.fields) {
        const line = current.split(/\r?\n/).find(line => line.toLowerCase().startsWith(field.label.toLowerCase() + ':'));
        if (line) Object.assign(saved, normalizeSalesDetails({ [field.label]: line.slice(line.indexOf(':') + 1).trim() }, settings));
    }
    const name = current.match(/(?:^|[.!]\s*|\b)([\p{L}\p{N}][\p{L}\p{N} '&.-]{1,70}?)\s+po\s+(?:ang\s+)?pangalan/iu) || current.match(/(?:business name|pangalan(?: ng (?:business|negosyo))?)\s*(?:ay|is|:)?\s+(.{2,80}?)(?:\s+po)?[.!]?$/i);
    if (name && positiveEvidence(current, name[1])) saved['Business Name'] = name[1].trim();
    const style = current.match(knownStyle);
    if (style && positiveEvidence(current, style[1]) && !/\?|sample|example|reference/i.test(current)) saved['Preferred Style'] = style[1];
    const goal = current.match(/(?:dumami|increase|more)\s+(?:ang\s+)?orders/i)?.[0];
    if (goal && positiveEvidence(current, goal)) saved['Goal ng video'] = goal;
    const product = current.match(/\b(milk tea|milktea|lechon belly)\b/i);
    if (product && positiveEvidence(current, product[0]) && !/\?|sample|example/i.test(current)) saved['Product or Service'] = product[0];
    const businessType = Object.keys(settings.industry_mappings).find(key => comparable(current).includes(comparable(key)));
    // The actual niche is confirmed; the normalized industry is only a suggestion.
    if (businessType && !/\?|sample|example|\b(?:not|hindi|wala)\b/i.test(current) && (!saved['Business Industry'] || /\b(?:business|negosyo|ako|kami|my|our|actually|pala)\b/i.test(current) || current.trim().length < 55)) saved['Business Industry'] = current.match(new RegExp(businessType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))?.[0] || businessType;
    const field = settings.fields.find(field => field.question === lastQuestion);
    if (field && current.trim().length <= 150 && !/[?\n]/.test(current) && !/^(?:hi|hello|ok|opo|yes|no|sige|thanks|salamat|skip|ayaw|pass|magkano|hm)\b/i.test(current) &&
        !/\b(?:sample|price|presyo|form|proceed|order na|gusto ko na|hindi|not)\b/i.test(current) && !saved[field.label] && !(field.label === 'Business Name' && businessType)) {
        Object.assign(saved, normalizeSalesDetails({ [field.label]: current.trim() }, settings));
    }
    return saved;
}
export function salesDetailProgress(details: unknown, settings: SalesSettings) {
    const collected = normalizeSalesDetails(details, settings);
    const fields = settings.fields.filter(field => field.enabled && field.required);
    const missing = fields.filter(field => !collected[field.label]).map(field => field.label);
    return { collected_details: collected, missing_details: missing, complete: missing.length === 0, required_count: fields.length,
        collected_count: fields.length - missing.length, saved_count: Object.keys(collected).length };
}
export function salesAssumptions(details: Record<string, string>, settings: SalesSettings): Record<string, string> {
    const context = comparable(details['Business Industry'] || details['Product or Service'] || '');
    const mapping = Object.entries(settings.industry_mappings).find(([niche]) => context.includes(comparable(niche)));
    return mapping && comparable(mapping[1]) !== context ? { 'Industry Category': mapping[1] } : {};
}

export function salesAssistantPrompt(settings: SalesSettings, progress: SalesProgress = {}): string {
    return '\n\nCURRENT SALES ASSISTANT POLICY (supersedes older sales sequencing, never ownership or stop rules): ' +
        'Preserve the existing relaxed Taglish voice, po, first-name addressing and no emojis. Be ' + settings.aggressiveness +
        '. Answer the inquiry first, explain one relevant benefit, recommend actual available work, then guide the next action. Ask ONE question, only for an enabled missing field. ' +
        'The form is optional. Never require form completion for prices or purchase. Never repeat the intro or form offer. Buying intent skips discovery. ' +
        'Form fields: ' + JSON.stringify(settings.fields) + '. Extract exact customer answers and latest corrections, never assumptions. ' +
        'Only use actual active library samples and approved catalog inclusions. Never invent discounts, urgency, production guarantees or free personalized videos. ' +
        (settings.pricing_enabled ? 'Prices ON: use only approved catalog prices; answer price questions immediately without a qualification gate. ' :
            'Prices OFF: never disclose any prices, deposits, balances, revision charges, quotations or price lists, including those in history/knowledge. Acknowledge price inquiries and explain the team can assist. This creates NO new handoff trigger. ') +
        'Do not claim a handoff unless the existing application performed it. Follow-ups resume the last unanswered question and never restart. Saved sales progress: ' + JSON.stringify(progress);
}

export function selectSalesSample(plan: Record<string, unknown>, knowledge: ChatbotKnowledgeMatch[], details: Record<string, string>, settings: SalesSettings, sent: string[] = []) {
    const words = (text: string) => comparable(text).split(' ').filter(word => word.length >= 3 && !['business', 'video', 'commercial', 'sample', 'service', 'shop', 'store', 'and', 'for'].includes(word));
    const category = salesAssumptions(details, settings)['Industry Category'] || '';
    const context = words([details['Business Industry'], details['Product or Service'], category].filter(Boolean).join(' '));
    const candidates = knowledge.filter(match => /MEDIA ASSET \(video\)|GOOGLE DRIVE MEDIA FILE \(video\)/i.test(match.content) || /^\[(?:Drive )?video\]/i.test(match.title)).flatMap(match => {
        const assignment = settings.samples.find(sample => sample.document_id === match.document_id);
        if (sent.includes(match.document_id) || assignment?.active === false) return [];
        const source = assignment ? [assignment.industry, assignment.product_category, assignment.style].join(' ') : match.title + ' ' + match.content.slice(0, 1200);
        const sourceWords = words(source);
        const topical = context.filter(word => sourceWords.includes(word)).length;
        const score = topical ? topical * 10 + (details['Preferred Style'] && comparable(source).includes(comparable(details['Preferred Style'])) ? 1 : 0) : 0;
        return score ? [{ match, score, reason: assignment?.description || 'Related sa ' + (details['Product or Service'] || details['Business Industry']) + ' ang existing sample na ito, kaya magandang reference para sa commercial mo.' }] : [];
    }).sort((a, b) => b.score - a.score);
    // Never trust an arbitrary model-selected ID or inactive assignment.
    plan.media_document_ids = []; plan.drive_file_document_ids = []; plan.link_document_id = null;
    const selected = candidates[0];
    if (selected) {
        const drive = /GOOGLE DRIVE MEDIA FILE \(/.test(selected.match.content) || /^\[Drive /i.test(selected.match.title);
        plan[drive ? 'drive_file_document_ids' : 'media_document_ids'] = [selected.match.document_id];
        plan.media_decision_reason = selected.reason;
    }
    return selected;
}

const MONEY = /(?:PHP|\u20b1|\bP)\s*\d|\d[\d,.]*\s*(?:pesos|PHP)\b|\b(?:price|presyo|cost|deposit|balance|bayad|discount)\b[^.!?\n]*\d/i;
export function renderSalesMessages(input: {
    parts: string[]; details: Record<string, string>; settings: SalesSettings; progress?: SalesProgress; history?: FacebookMessage[];
    pageId: string; customerMessage: string; contactName?: string | null; formUrl?: string; rates?: CommercialVideoPricing[];
    sampleReason?: string; sampleId?: string; buyingIntent?: boolean; followUp?: boolean; handoff?: boolean; requestType?: string | null;
}) {
    const { settings, details } = input;
    const progress = input.progress || {};
    const prior = (input.history || []).filter(message => message.from?.id === input.pageId).map(message => message.message || '');
    const introduced = !!progress.introduced_at || (progress.introduction_pending !== true && (!!Object.keys(details).length || prior.length > 0));
    const formOffered = !!progress.form_offered_at || !!progress.form_submitted_at || prior.some(text => /Optional quick form|optional ang form|Kindly fill out these details/i.test(text));
    const messages: string[] = [];
    if (!introduced && !input.followUp && !input.buyingIntent) messages.push(settings.introduction + '\nSALES PROCESS:\n' + settings.process_steps.map((step, i) => 'STEP ' + (i + 1) + ': ' + step).join('\n'));
    const priceAsked = isCommercialVideoPriceRequested(input.customerMessage);
    const freeRequest = input.requestType === 'free_script' ? 'free script' : input.requestType === 'free_concept' ? 'free concept' : null;
    const freeInquiry = /\b(?:free|libre)\b/i.test(input.customerMessage) && /\b(?:concept|script)\b/i.test(input.customerMessage);
    // The model supplies education only. App-owned questions, samples and catalog
    // renderers enforce one question and prevent stale prompts leaking money.
    const facts = cleanCommercialVideoCopy(input.parts.join('\n'), input.contactName).split(/\r?\n|(?<=[.!?])\s+/).filter(line =>
        line && !line.includes('?') && !MONEY.test(line) && !/\d|https?:\/\/|\b(?:free|libre|promo|discount|poster|caption|add.on|bonus|pesos?|piso|PHP|deposit|balance|quotation|quote|payment|bayad|costs?)\b|form|step|pricing|prices?|presyo|package|handoff|ipapasa|forward|pakisagutan|fill out|summary|business name:|preferred style:/i.test(line));
    const education = facts.slice(0, 2).join(' ').slice(0, 320);
    if (education && !(priceAsked && !settings.pricing_enabled) && !prior.some(text => text.includes(education))) messages.push(education);
    if (freeInquiry || freeRequest) messages.push('Walang bayad ang ' + (freeRequest || 'free concept o free script') + ' at walang kailangang bilhin. Hiwalay ang paid video production.');
    if (priceAsked && !settings.pricing_enabled && !freeInquiry) messages.push('May iba’t ibang packages po tayo depende sa commercial na kailangan mo. Para sa exact pricing, our team can assist you with the available options.');
    const validRates = (input.rates || []).filter(rate => rate.ownerVerifiedCatalog && !rate.referenceOnly);
    if (settings.pricing_enabled && !freeInquiry && !freeRequest && validRates.length && (priceAsked || (!input.followUp && !progress.pricing_inquiry && salesDetailProgress(details, settings).complete))) messages.push(renderCommercialVideoPriceList(validRates, details['Business Name']));
    else if (priceAsked && settings.pricing_enabled && !freeInquiry && !freeRequest) messages.push('Iko-confirm muna ng team ang approved package options para sa commercial mo.');
    if (input.sampleReason) messages.push(input.sampleReason);
    const rate = validRates.find(rate => rate.durationSeconds === commercialVideoDurationSeconds(details['Preferred Video Length'] || '')) || validRates[0];
    const freebiesKey = rate ? [rate.packageName, rate.posters, rate.addonCount, rate.captionCount, rate.bonusVideoSeconds].join(':') : '';
    if (rate && !progress.freebies_presented?.includes(freebiesKey) && (input.sampleId || salesDetailProgress(details, settings).complete)) {
        const included = [rate.posters ? rate.posters + ' poster ads' : '', rate.addonCount ? rate.addonCount + ' additional ' + rate.addonDurationSeconds + '-second clips' : '',
            rate.captionCount ? rate.captionCount + ' ready-to-post captions' : '', rate.bonusVideoSeconds ? 'an extra ' + rate.bonusVideoSeconds + '-second video' : ''].filter(Boolean);
        if (included.length) messages.push('Sa approved ' + rate.packageName + ' (' + rate.durationSeconds + '-second) package, kasama ang ' + included.join(', ') + '.');
    }
    const formRequested = /(?:send|show|open|resend|pahingi|paki|reopen|ulit|fill|sagutan).{0,30}form|form.{0,15}(?:ulit|please|po)/i.test(input.customerMessage);
    if ((!formOffered && !input.followUp && !input.buyingIntent) || (formRequested && !input.followUp)) {
        messages.push('Optional quick form: puwede mong sagutan ito para mas mabilis, o tuloy lang tayo sa chat. Hindi kailangang kumpletuhin bago mag-proceed.' +
            (input.formUrl ? '\n' + input.formUrl : '\n' + settings.fields.filter(field => field.enabled).map(field => field.label + ': ' + (details[field.label] || '')).join('\n')));
    }
    const missing = salesDetailProgress(details, settings).missing_details;
    const unanswered = missing.find(label => settings.fields.find(field => field.label === label)?.question !== progress.last_question) || missing[0];
    const productionQuestion = input.buyingIntent && settings.collection_enabled ? getCommercialVideoNextQuestion(details, prior) : undefined;
    if (input.buyingIntent && !input.handoff) messages.push(freeRequest ? 'Sige po, ihanda natin ang ' + freeRequest + ' mo. Ituloy natin ang details dito sa chat.' : 'Sige po, simulan natin ang commercial para sa business mo. Itutuloy natin ang production details dito sa chat.');
    const question = productionQuestion || (input.buyingIntent || !settings.collection_enabled || !missing.length
        ? settings.aggressiveness === 'gentle' ? 'Gusto mo bang ituloy natin ang commercial para sa business mo?' : 'Simulan na natin ang commercial para sa business mo, ready ka na bang mag-proceed?'
        : settings.fields.find(field => field.label === unanswered)!.question);
    if (input.handoff) messages.push('Ipapasa sa team ang request mo' + (freeRequest ? ' para sa ' + freeRequest : '') + '. Available na sa kanila ang mga details na na-share mo.');
    else messages.push(question);
    return { messages: settings.pricing_enabled ? messages : messages.filter(message => !MONEY.test(message)), progress: { stage: input.handoff ? 'existing_human_handoff' : input.buyingIntent ? 'sales_ready' : input.followUp ? 'follow_up' : input.sampleId ? 'sample_recommendation' : !missing.length ? 'offer_presentation' : 'information_gathering',
        temperature: input.buyingIntent && !freeRequest ? 'hot' : input.followUp ? 'cold' : 'warm', last_question: question,
        pricing_inquiry: progress.pricing_inquiry === true || priceAsked,
        ...(!introduced && !input.followUp && !input.buyingIntent ? { introduced_at: new Date().toISOString() } : {}),
        ...(!input.followUp ? { introduction_pending: false } : {}),
        ...(!formOffered && !input.followUp && !input.buyingIntent ? { form_offered_at: new Date().toISOString() } : {}),
        ...(input.sampleId ? { recommended_samples: [input.sampleId] } : {}),
        ...(freebiesKey && messages.some(text => text.startsWith('Sa approved ')) ? { freebies_presented: [freebiesKey] } : {}) } as SalesProgress };
}
