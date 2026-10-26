import type { FacebookMessage } from '@/types';
import { normalizeContactName } from '@/lib/contact-names';
import { COMMERCIAL_VIDEO_EARLY_FORM_REASON, containsCommercialVideoForm, containsLegacyCommercialVideoForm, getMissingCommercialVideoDetails, normalizeCommercialVideoDetails } from '@/lib/chatbot-intake';
import type { ChatbotKnowledgeMatch } from '@/lib/chatbot-knowledge';

function sampleKind(match: ChatbotKnowledgeMatch): 'drive_file' | 'media' | null {
    if (/GOOGLE DRIVE MEDIA FILE \(/.test(match.content) || /^\[Drive (?:image|video)\]/i.test(match.title)) return 'drive_file';
    if (/MEDIA ASSET \(/.test(match.content) || /^\[(?:image|video)\]/i.test(match.title)) return 'media';
    return null;
}

export function hasVerifiedCommercialVideoSample(plan: Record<string, unknown>, knowledge: ChatbotKnowledgeMatch[]): boolean {
    const selected = [
        ...(Array.isArray(plan.media_document_ids) ? plan.media_document_ids : typeof plan.media_document_id === 'string' ? [plan.media_document_id] : []),
        ...(Array.isArray(plan.drive_file_document_ids) ? plan.drive_file_document_ids : []), plan.link_document_id
    ].filter((id): id is string => typeof id === 'string').map(id => id.trim());
    return knowledge.some(match => selected.includes(match.document_id) && (sampleKind(match) || /GOOGLE DRIVE MEDIA FOLDER:/.test(match.content) || /^\[Drive folder\]/i.test(match.title)));
}

/** Use only a retrieved portfolio asset whose title matches the business. */
export function ensureCommercialVideoSampleSelection(plan: Record<string, unknown>, knowledge: ChatbotKnowledgeMatch[], business: string | null): void {
    if (!business || hasVerifiedCommercialVideoSample(plan, knowledge)) return;
    const words = (text: string) => text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
    const generic = new Set(['preview', 'business', 'company', 'commercial', 'video', 'sample', 'the', 'and', 'for', 'inc', 'ltd', 'corp', 'namin', 'kami', 'para']);
    const businessWords = words(business).filter(word => !generic.has(word));
    const candidates = knowledge.filter(match => sampleKind(match)).map(match => {
        const titleWords = new Set(words(match.title));
        const overlap = businessWords.filter(word => titleWords.has(word)).length;
        return { match, score: overlap ? overlap * 10 + (/video/i.test(match.title) ? 1 : 0) : 0 };
    }).filter(candidate => candidate.score > 0).sort((a, b) => b.score - a.score);
    const chosen = candidates[0]?.match;
    if (!chosen) return;
    plan.media_document_ids = sampleKind(chosen) === 'media' ? [chosen.document_id] : [];
    plan.drive_file_document_ids = sampleKind(chosen) === 'drive_file' ? [chosen.document_id] : [];
    plan.link_document_id = null;
    plan.media_decision_reason = 'Existing portfolio title matches the verified business context: ' + business;
}

export type CommercialVideoPricing = {
    packageName: string; durationSeconds: number; pricePHP: number; referenceOnly: boolean;
    addonCount: number; addonDurationSeconds: number; posters: number; caption: boolean;
    regularPricePHP?: number;
    captionCount?: number;
    bonusVideoSeconds?: number;
    hook?: string;
    ownerVerifiedCatalog?: boolean;
};

/** Read one duration row from the existing knowledge, without copying its
 * catalog into code or confusing short add-ons with the main video. */
export function getCommercialVideoPricing(knowledge: ChatbotKnowledgeMatch[], durationSeconds: number | null): CommercialVideoPricing | null {
    if (!durationSeconds) return null;
    const catalog = knowledge.find(source => source.contact_pricing_catalog)?.contact_pricing_catalog;
    if (catalog) {
        const option = catalog.options.find(option => option.duration_seconds === durationSeconds);
        if (!option) return null;
        return { packageName: catalog.name + (option.package_name ? ' / ' + option.package_name : ''), durationSeconds,
            pricePHP: option.price, referenceOnly: false, addonCount: option.addon_videos, addonDurationSeconds: 8,
            posters: option.posters, caption: option.captions > 0, captionCount: option.captions,
            bonusVideoSeconds: option.bonus_video_seconds, regularPricePHP: option.regular_price, hook: catalog.hook,
            ownerVerifiedCatalog: true };
    }
    const approvedCatalog = /current owner-approved promo catalog|owner-approved promo price list/i;
    const sources = [...knowledge].sort((a, b) => Number(approvedCatalog.test(b.content)) - Number(approvedCatalog.test(a.content)));
    for (const source of sources) for (const line of source.content.split('\n')) {
        const columns = line.split('|').map(column => column.trim()).filter(Boolean);
        if (columns.length < 6 || durationIn(columns[1]) !== durationSeconds) continue;
        const price = columns[2].match(/(?:PHP|P|\u20b1)\s*([\d,]+(?:\.\d{1,2})?)/i);
        if (!price) continue;
        const addon = columns[3].match(/(\d+)\s*[x\u00d7]\s*(\d+)/i);
        const regularPrice = columns[6]?.match(/(?:PHP|P|\u20b1)\s*([\d,]+(?:\.\d{1,2})?)/i);
        return { packageName: columns[0], durationSeconds, pricePHP: Number(price[1].replace(/,/g, '')),
            referenceOnly: !approvedCatalog.test(source.content) && /historical reference price|reference terms|reference price|default package template|working reference/i.test(source.content),
            addonCount: Number(addon?.[1] || 0), addonDurationSeconds: Number(addon?.[2] || 0),
            posters: Number(columns[4]) || 0, caption: /^included|yes|true$/i.test(columns[5]),
            ...(regularPrice ? { regularPricePHP: Number(regularPrice[1].replace(/,/g, '')) } : {}) };
    }
    return null;
}

/** All durations from the customer's catalog, or one verified knowledge catalog.
 * Never combine competing catalogs or let an unsupported selection hide the list. */
export function getCommercialVideoPriceList(knowledge: ChatbotKnowledgeMatch[]): CommercialVideoPricing[] {
    const contact = knowledge.find(source => source.contact_pricing_catalog);
    if (contact?.contact_pricing_catalog) return contact.contact_pricing_catalog.options.flatMap(option => {
        const rate = getCommercialVideoPricing([contact], option.duration_seconds);
        return rate ? [rate] : [];
    });
    const approved = /current owner-approved promo catalog|owner-approved promo price list/i;
    const sources = [...knowledge].sort((a, b) => Number(approved.test(b.content)) - Number(approved.test(a.content)));
    for (const source of sources) {
        const durations = [...new Set(source.content.split('\n').flatMap(line => {
            const columns = line.split('|').map(column => column.trim()).filter(Boolean);
            const duration = columns.length >= 6 ? durationIn(columns[1]) : null;
            return duration ? [duration] : [];
        }))];
        const rates = durations.flatMap(duration => {
            const rate = getCommercialVideoPricing([source], duration);
            return rate ? [rate] : [];
        });
        if (rates.length) return rates;
    }
    return [];
}

export type CommercialVideoSalesStep = 'business' | 'sample' | 'duration' | 'pricing_process' | 'decision' | 'form' | 'complete';
export type CommercialVideoSalesFlow = {
    step: CommercialVideoSalesStep;
    business: string | null;
    durationSeconds: number | null;
    sampleSent: boolean;
    sampleHandled: boolean;
    processSent: boolean;
    pricingSent: boolean;
    formSent: boolean;
    formRequested: boolean;
    processRequested: boolean;
    earlyFormSent?: boolean;
    intakeFormSent?: boolean;
    informationCount?: number;
    pricingReady?: boolean;
};

export function commercialVideoFirstName(value: unknown): string | null {
    const name = normalizeContactName(value);
    if (!name || /^(?:the customer|customer|contact|user|test user)$/i.test(name)) return null;
    const untitled = name.replace(/^(?:(?:mr|mrs|ms|miss|dr|sir|ma['’]?am|mam|madam|boss)\.?\s+)+/i, '');
    return untitled.match(/^[\p{L}][\p{L}\p{M}'’.-]*/u)?.[0] || null;
}

export function cleanCommercialVideoCopy(text: string, contactName?: string | null): string {
    text = text.replace(/\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|[\uFE0E\uFE0F]|\u200D\p{Extended_Pictographic})*|\p{Regional_Indicator}|[\uFE0E\uFE0F\u20E3\u200D]/gu, '').trimEnd();
    const fieldLine = /^(?:\d+[.)]\s*)?(?:Business Name|Page \/ Social Media Link|Business Location|Location|Goal ng video|Preferred Video Length|Preferred Style|Contact Number|Portrait or Landscape\?)[?:]?/i;
    if (text.includes('\n')) return text.split('\n').map(line => fieldLine.test(line) ? line : cleanCommercialVideoCopy(line, contactName)).join('\n').trim();
    if (fieldLine.test(text)) return text;
    let cleaned = text
        .replace(/^(?:(?:hi|hello)\s+)?(?:sir|ma['’]?am|mam|madam|boss)(?:\s+po)?\b[,.!]?\s*/i, '')
        .replace(/,\s*(?:sir|ma['’]?am|mam|madam|boss)(?:\s+po)?(?=[,.!?]|$)/gi, '')
        .replace(/[ \t]+/g, ' ').replace(/ +([,.!?])/g, '$1').trim();
    const firstName = commercialVideoFirstName(contactName);
    const fullName = contactName?.trim();
    if (firstName && fullName && fullName !== firstName) {
        for (const address of [fullName, fullName.split(/\s+/).at(-1)!]) {
            if (address === firstName) continue;
            const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            cleaned = cleaned.replace(new RegExp(`^((?:(?:hi|hello|dear|salamat|thanks|sige|okay|ok)(?:\\s+po)?\\s*,?\\s+)?)${escaped}(?=[,!?]|\\s+po\\b|\\.$|$)`, 'i'), (_match, greeting) => greeting + firstName);
        }
    }
    return cleaned;
}

/** Use the saved first name once per turn. Unknown names stay unknown. */
export function personalizeCommercialVideoMessages(parts: string[], contactName?: string | null): string[] {
    const cleaned = parts.map(part => cleanCommercialVideoCopy(part, contactName)).filter(Boolean);
    const firstName = commercialVideoFirstName(contactName);
    if (firstName && cleaned.length && !cleaned.some(part => new RegExp(`^(?:(?:hi|hello)\\s+)?${firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[,!]`, 'iu').test(part))) {
        const conversational = cleaned[0].replace(/^(Ano(?:ng)?|Ilang|Saan(?:g)?|Ito|Pakisagutan|May|Wala|Gusto|Para)\b/, word => word.toLowerCase());
        cleaned[0] = `${firstName}, ${conversational}`;
    }
    return cleaned;
}

const durationQuestion = /(?:ilang|gaano|how|preferred|anong|ano).{0,55}(?:seconds?|segundo|duration|haba|length|katagal)|(?:duration|length).{0,30}\?/i;
const businessQuestion = /(?:anong|ano|what|which).{0,45}(?:business|negosyo)|(?:business|negosyo).{0,35}(?:name|pangalan).{0,15}\?/i;
const sampleRequest = /\b(?:samples?|portfolio|examples?)\b/i;
const sampleDelivery = /(?:ito|heto|here|tingnan|panoorin|check|previous|existing|past|sample para|sample ng).{0,90}(?:samples?|portfolio|examples?)|(?:samples?|portfolio|examples?).{0,60}(?:ito|here|namin|nating|below|button|card|previous|existing)/i;
const unavailableSample = /wala|walang|unavailable|not available|hindi.*available|no (?:verified|matching|available)/i;

export function isCommercialVideoSampleRequested(text: string): boolean { return sampleRequest.test(text); }
export function isCommercialVideoPriceRequested(text: string): boolean { return /magkano|how much|\bhm\b|\b(?:price|presyo|pricing|rates?|cost|package)\b/i.test(text); }

function durationIn(text: string, first = false): number | null {
    const matches = [...text.matchAll(/\b(\d{1,3}(?:\.\d+)?)[\s-]*(s(?:ec(?:ond)?s?)?|segundos?|mins?|minutes?|minutos?)\b/gi)];
    const match = first ? matches[0] : matches.at(-1);
    if (!match) return null;
    const value = Number(match[1]) * (/^(?:min)/i.test(match[2]) ? 60 : 1);
    return value > 0 && value <= 600 ? value : null;
}

/** Derive progress from real messages, never from a model's claimed stage.
 * Preserve earlier answers, holds, and reminder schedules. */
export function resolveCommercialVideoSalesFlow(input: {
    history?: FacebookMessage[]; pageId: string; inboundMessage?: string; details?: unknown;
    businessType?: unknown; hasClearRequest?: boolean; requestType?: string | null;
}): CommercialVideoSalesFlow {
    const messages = [...(input.history || [])].filter(message => message.message?.trim());
    if (messages.every(message => Number.isFinite(Date.parse(message.created_time)))) {
        messages.sort((a, b) => Date.parse(a.created_time) - Date.parse(b.created_time));
    } else messages.reverse();
    const inbound = input.inboundMessage?.trim() || '';
    const lastMessage = messages.at(-1);
    if (inbound && (!lastMessage || lastMessage.from?.id === input.pageId || lastMessage.message.trim() !== inbound)) {
        messages.push({ id: '__sales_inbound__', from: { id: '__customer__', name: '' }, message: inbound, created_time: '' });
    }
    const collected = normalizeCommercialVideoDetails(input.details);
    let business: string | null = collected['Business Name'] || null;
    let durationSeconds: number | null = durationIn(collected['Preferred Video Length'] || '');
    let pricedDurationSeconds: number | null = null;
    let sampleSent = false, sampleHandled = false, processSent = false, formSent = false;
    let earlyFormSent = false, intakeFormSent = false, fullPriceListSent = false;
    let lastPageMessage = '';
    for (const message of messages) {
        const text = message.message.trim();
        if (message.from?.id === input.pageId) {
            if (/^(?:[^,\n]+,\s*)?PRICING PARA SA /im.test(text)) {
                if (/BUONG PRICE LIST/i.test(text)) fullPriceListSent = true;
                const pricingBody = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : text;
                pricedDurationSeconds = durationIn(pricingBody, true) || durationSeconds;
            }
            if (containsCommercialVideoForm(text) || containsLegacyCommercialVideoForm(text)) {
                formSent = true;
                if (text.toLowerCase().includes(COMMERCIAL_VIDEO_EARLY_FORM_REASON.toLowerCase())) earlyFormSent = true;
                else intakeFormSent = true;
            }
            if (/STEP-BY-STEP PROCESS PO:/i.test(text) && /(?:^|\n)7[.) ]/.test(text)) processSent = true;
            if (sampleDelivery.test(text) && !unavailableSample.test(text) && !/\?\s*$/.test(text)) sampleSent = sampleHandled = true;
            if (sampleRequest.test(text) && unavailableSample.test(text) && !/\?\s*$/.test(text)) sampleHandled = true;
            lastPageMessage = text;
            continue;
        }
        const explicitDuration = durationIn(text);
        if (explicitDuration) durationSeconds = explicitDuration;
        else if (durationQuestion.test(lastPageMessage) && /^\s*\d{1,3}\s*(?:po|please)?[.!]?\s*$/i.test(text)) {
            const value = Number(text.match(/\d+/)?.[0]);
            if (value > 0 && value <= 600) durationSeconds = value;
        }
        if (!business && businessQuestion.test(lastPageMessage) && text.length <= 200 &&
            !/\?|^(?:hi|hello|yes|no|opo|oo|sige|ok(?:ay)?|thanks|salamat|magkano|how much|hm|send|sample|price|paano|gusto|pwede|puwede)\b/i.test(text)) {
            business = text.replace(/\s+po[.!]?$/i, '').trim();
        }
        if (!business) business = text.match(/\b(?:bakery|bakeshop|cafe|café|coffee shop|restaurant|resto|salon|spa|clinic|dental|laundry|carwash|car wash|real estate|resort|hotel|construction|printing|food business|online shop|sari.sari store|barbershop|gym|school|milktea|milk tea|skincare|auto repair|travel agency)\b/i)?.[0] || null;
        lastPageMessage = '';
    }
    // A niche identified by the model must be quoted from a real customer turn.
    if (!business && typeof input.businessType === 'string' && input.businessType.trim() && input.businessType.length <= 120 &&
        messages.some(message => message.from?.id !== input.pageId && message.message.toLowerCase().includes((input.businessType as string).trim().toLowerCase()))) {
        business = input.businessType.trim();
    }
    const latestCustomer = inbound || messages.filter(message => message.from?.id !== input.pageId).at(-1)?.message || '';
    if (!durationIn(inbound) && !/^\s*\d{1,3}\s*(?:po|please)?[.!]?\s*$/i.test(inbound) && collected['Preferred Video Length']) durationSeconds = durationIn(collected['Preferred Video Length']);
    const formRequested = /\b(?:(?:send|show|resend|pahingi|paki(?:send)?|pakita|ibigay)\b.{0,30}\bform|form\s+(?:again|ulit|please|po)|(?:fill.up|fill out|sagutan)\b.{0,20}\bform)\b/i.test(latestCustomer);
    const processRequested = /step.by.step|proseso|\bprocess\b|paano.{0,30}(?:magpagawa|umorder|order|payment|bayad|gawin)/i.test(latestCustomer);
    const complete = getMissingCommercialVideoDetails(collected).length === 0;
    const freeRequest = input.hasClearRequest && /^free_(?:concept|script)$/.test(input.requestType || '');
    const information = new Set(Object.keys(collected));
    if (business) information.add('Business Name');
    if (durationSeconds) information.add('Preferred Video Length');
    const informationCount = information.size;
    const pricingReady = Boolean(business && informationCount >= 2);
    const pricingSent = fullPriceListSent || (durationSeconds !== null && durationSeconds === pricedDurationSeconds);
    const step: CommercialVideoSalesStep = complete ? 'complete' : intakeFormSent || formRequested || freeRequest ? 'form'
        : !business ? 'business' : !sampleHandled ? 'sample' : !pricingReady ? 'duration'
            : !processSent || !pricingSent ? 'pricing_process' : input.hasClearRequest ? 'form' : 'decision';
    return { step, business, durationSeconds, sampleSent, sampleHandled, processSent, pricingSent, formSent, formRequested, processRequested,
        earlyFormSent, intakeFormSent, informationCount, pricingReady };
}

export function commercialVideoSalesFlowPrompt(flow: CommercialVideoSalesFlow, contactName?: string | null): string {
    return '\n\nCURRENT VERIFIED SALES FLOW:\n' + JSON.stringify(flow) + '\n' +
        `Use only the first name ${JSON.stringify(commercialVideoFirstName(contactName))}; never address the customer by a surname, sir, maam, boss, or a made-up name. ` +
        'Follow ask business -> early prefilled form and sample -> another customer detail, preferably duration -> WHOLE verified price list and full process -> proceed question -> prefilled form again at normal intake. Continue without restarting. Repeat a relevant existing sample or prefilled form when useful/requested; avoid repeated pitches and near-identical questions. ' +
        'Answer direct questions first; an explicit request for the form or a free concept/script can proceed to intake immediately. Save any supplied form details at every step. ' +
        'For step=business ask what business they want the video for. Include business_type in JSON only as an exact short quote from their messages; this is context, not the Business Name field. ' +
        'For step=sample select the most relevant existing portfolio media or indexed Drive file using its verified document_id, even if the customer did not separately ask for samples. Do not claim a sample is attached without selecting a valid asset. If no suitable sample is available say so honestly and ask duration. ' +
        'For step=duration ask how many seconds they want. Require business plus another distinct customer detail before ANY money amounts. Business type and business name count once. For step=pricing_process provide ALL durations and inclusions from the verified catalog in ONE price-list message; distinguish original From price, current promo total, PHP150 down payment, and balance. Do not repeat a full list just because the chosen duration changed. Repeat the complete assigned list on a direct price request. Do not repeat that process unless requested. The main commercial video and its FREE 8-second ADD-ON videos are different deliverables; use the exact counts in the current approved catalog and never replace the main duration with the add-ons. The add-ons can be added to the main video or used as extra short promo clips. Clearly label historical/template/reference rates as reference only, pending team confirmation, never as approved live quotes. If no applicable rate is available, say the team must confirm it, never invent a price. The app adds the exact seven-step process when needed and a separate buying question. ' +
        'For step=decision ask whether they want to proceed; the app adds a Fill out form button. Clicking it asks for the form only, never buying consent. Duration questions have 16s, 20s, 24s, 30s and 1 min choices; other typed lengths are accepted. The early form does not skip discovery or pricing. For step=form the app sends the exact eight-field form at normal intake, prefilled with known answers, then one missing-field question. Resend it only for a new explicit customer request; intake_action cannot authorize an unsolicited repeat. Scheduled reminders do not replay old form, price or process requests. Every form and price explains the free concept needs no fee/purchase; paid production is separate. ' +
        'Every active response and scheduled reminder ends with one relevant question. Keep brief ordinary answers and their question together rather than splitting sentences into notifications. Full pricing, the numbered process plus revision note, and the entire form remain intact, exempt from short-answer caps. Follow structured messages with a relevant question. ' +
        'Write the current factual answer in messages. Do not duplicate the form or process: the app renders those. Use natural Taglish and no emojis. Respect opt-outs, refusals, and team handoff stops.\n';
}
