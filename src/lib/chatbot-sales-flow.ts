import type { FacebookMessage } from '@/types';
import { normalizeContactName } from '@/lib/contact-names';
import { containsCommercialVideoForm, getMissingCommercialVideoDetails, normalizeCommercialVideoDetails } from '@/lib/chatbot-intake';
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
};

/** Read one duration row from the existing knowledge, without copying its
 * catalog into code or confusing short add-ons with the main video. */
export function getCommercialVideoPricing(knowledge: ChatbotKnowledgeMatch[], durationSeconds: number | null): CommercialVideoPricing | null {
    if (!durationSeconds) return null;
    const content = knowledge.map(match => match.content).join('\n');
    for (const line of content.split('\n')) {
        const columns = line.split('|').map(column => column.trim()).filter(Boolean);
        if (columns.length < 6 || durationIn(columns[1]) !== durationSeconds) continue;
        const price = columns[2].match(/(?:PHP|P|\u20b1)\s*([\d,]+(?:\.\d{1,2})?)/i);
        if (!price) continue;
        const addon = columns[3].match(/(\d+)\s*[x\u00d7]\s*(\d+)/i);
        return { packageName: columns[0], durationSeconds, pricePHP: Number(price[1].replace(/,/g, '')),
            referenceOnly: /historical reference price|reference terms|reference price|default package template|working reference/i.test(content),
            addonCount: Number(addon?.[1] || 0), addonDurationSeconds: Number(addon?.[2] || 0),
            posters: Number(columns[4]) || 0, caption: /^included|yes|true$/i.test(columns[5]) };
    }
    return null;
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
};

export function commercialVideoFirstName(value: unknown): string | null {
    const name = normalizeContactName(value);
    if (!name || /^(?:the customer|customer|contact|user|test user)$/i.test(name)) return null;
    const untitled = name.replace(/^(?:(?:mr|mrs|ms|miss|dr|sir|ma['’]?am|mam|madam|boss)\.?\s+)+/i, '');
    return untitled.match(/^[\p{L}][\p{L}\p{M}'’.-]*/u)?.[0] || null;
}

export function cleanCommercialVideoCopy(text: string, contactName?: string | null): string {
    text = text.replace(/\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|[\uFE0E\uFE0F]|\u200D\p{Extended_Pictographic})*|\p{Regional_Indicator}|[\uFE0E\uFE0F\u20E3\u200D]/gu, '').trimEnd();
    const fieldLine = /^(?:\d+[.)]\s*)?(?:Business Name|Business Location|Goal ng video|Contact Number):/i;
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
 * Existing four-field storage, holds, and reminder schedules need no migration. */
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
    let durationSeconds: number | null = null;
    let pricedDurationSeconds: number | null = null;
    let sampleSent = false, sampleHandled = false, processSent = false, formSent = false;
    let lastPageMessage = '';
    for (const message of messages) {
        const text = message.message.trim();
        if (message.from?.id === input.pageId) {
            if (/^(?:[^,\n]+,\s*)?PRICING PARA SA /im.test(text)) {
                const pricingBody = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : text;
                pricedDurationSeconds = durationIn(pricingBody, true) || durationSeconds;
            }
            if (containsCommercialVideoForm(text)) formSent = true;
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
    const formRequested = /\b(?:(?:send|show|resend|pahingi|paki(?:send)?|pakita|ibigay)\b.{0,30}\bform|form\s+(?:again|ulit|please|po)|(?:fill.up|fill out|sagutan)\b.{0,20}\bform)\b/i.test(latestCustomer);
    const processRequested = /step.by.step|proseso|\bprocess\b|paano.{0,30}(?:magpagawa|umorder|order|payment|bayad|gawin)/i.test(latestCustomer);
    const complete = getMissingCommercialVideoDetails(collected).length === 0;
    const freeRequest = input.hasClearRequest && /^free_(?:concept|script)$/.test(input.requestType || '');
    const pricingSent = durationSeconds !== null && durationSeconds === pricedDurationSeconds;
    const step: CommercialVideoSalesStep = complete ? 'complete' : formSent || formRequested || freeRequest ? 'form'
        : !business ? 'business' : !sampleHandled ? 'sample' : !durationSeconds ? 'duration'
            : !processSent || !pricingSent ? 'pricing_process' : input.hasClearRequest ? 'form' : 'decision';
    return { step, business, durationSeconds, sampleSent, sampleHandled, processSent, pricingSent, formSent, formRequested, processRequested };
}

export function commercialVideoSalesFlowPrompt(flow: CommercialVideoSalesFlow, contactName?: string | null): string {
    return '\n\nCURRENT VERIFIED SALES FLOW:\n' + JSON.stringify(flow) + '\n' +
        `Use only the first name ${JSON.stringify(commercialVideoFirstName(contactName))}; never address the customer by a surname, sir, maam, boss, or a made-up name. ` +
        'Follow business -> existing relevant sample -> duration -> verified pricing and the full seven-step process -> buying decision -> four-field form. Continue from the current step without restarting. Repeat a relevant existing sample or prefilled form when it helps or the customer asks; avoid repeated pitches and near-identical questions/reminders. ' +
        'Answer direct questions first; an explicit request for the form or a free concept/script can proceed to intake immediately. Save any supplied form details at every step. ' +
        'For step=business ask what business they want the video for. Include business_type in JSON only as an exact short quote from their messages; this is context, not the Business Name field. ' +
        'For step=sample select the most relevant existing portfolio media or indexed Drive file using its verified document_id, even if the customer did not separately ask for samples. Do not claim a sample is attached without selecting a valid asset. If no suitable sample is available say so honestly and ask duration. ' +
        'For step=duration ask how many seconds they want. For step=pricing_process provide the verified selected-duration price in one intact messages entry, including known inclusions; distinguish total, PHP150 down payment, and balance. A changed duration requires updated pricing before the form, even if the process was already explained. Do not repeat that process unless requested. A main 24-second video and two 8-second ADD-ON videos are different deliverables; never replace the main duration with the add-ons. Clearly label historical/template/reference rates as reference only, pending team confirmation, never as approved live quotes. If no applicable rate is available, say the team must confirm it, never invent a price. The app adds the exact seven-step process when needed and a separate buying question. ' +
        'For step=decision ask whether they want to proceed with the commercial video. For step=form the app sends one intact form prefilled with known answers, then one specific missing-field question. Set intake_action=send_form when a useful repeat will help the customer answer. Every form and pricing message explains that a free concept is available with no fee or purchase requirement; paid-video charges are separate. ' +
        'Every active response and scheduled reminder ends with one relevant question. Full pricing, the numbered process plus revision note, and the entire form are each single messages, exempt from sentence splitting and short-answer caps. Follow them with a separate relevant question. ' +
        'Write the current factual answer in messages. Do not duplicate the form or process: the app renders those. Use natural Taglish and no emojis. Respect opt-outs, refusals, and team handoff stops.\n';
}
