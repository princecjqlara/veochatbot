import type { FacebookMessage } from '@/types';
import { getMissingCommercialVideoDetails, normalizeCommercialVideoDetails, type CommercialVideoIntakeAction } from '@/lib/chatbot-intake';

export type CommercialVideoRequestType = 'commercial_video' | 'free_concept' | 'free_script';
export type CommercialVideoRequest = {
    has_clear_request: boolean;
    request_type: CommercialVideoRequestType | null;
    request_evidence: string | null;
    request_evidence_message_id?: string | null;
};

export function isCommercialVideoIntake(config: { commercial_video_intake_enabled?: unknown } | null | undefined): boolean {
    return config?.commercial_video_intake_enabled === true;
}

export function evaluateCommercialVideoIntake(details: unknown, hasClearRequest: boolean) {
    const collected = normalizeCommercialVideoDetails(details);
    const missing = getMissingCommercialVideoDetails(collected);
    const formComplete = missing.length === 0;
    const nextAction: CommercialVideoIntakeAction = !formComplete
        ? Object.keys(collected).length ? 'ask_missing_field' : 'send_form'
        : hasClearRequest ? 'handoff' : 'clarify_next_step';
    return { missingRequiredFields: missing, missing_details: missing, formComplete, clearRequest: hasClearRequest,
        needsContinuation: !formComplete || !hasClearRequest, nextAction };
}

const EMPTY_REQUEST: CommercialVideoRequest = { has_clear_request: false, request_type: null, request_evidence: null };

function requestType(text: string): CommercialVideoRequestType | null {
    if (/\b(?:concept|konsepto)\b/i.test(text)) return 'free_concept';
    if (/\bscript\b/i.test(text)) return 'free_script';
    if (/\b(?:commercial|video|ad video|advertisement)\b/i.test(text)) return 'commercial_video';
    return null;
}

/** Only explicit requests or unambiguous acceptance of a preceding offer count.
 * Price/portfolio inquiries and generic acknowledgements never create intent. */
export function extractClearVideoRequest(history: FacebookMessage[], pageId: string): CommercialVideoRequest {
    const readable = history.filter(message => typeof message.message === 'string' && message.message.trim() && message.from?.id);
    const ordered = [...readable];
    if (ordered.every(message => Number.isFinite(Date.parse(message.created_time)))) {
        ordered.sort((a, b) => Date.parse(a.created_time) - Date.parse(b.created_time));
    } else ordered.reverse(); // Messenger histories are newest first.
    let current: CommercialVideoRequest = { ...EMPTY_REQUEST };
    let lastPageText = '';
    for (const message of ordered) {
        const text = message.message.trim();
        if (message.from.id === pageId) { lastPageText = text; continue; }
        if (/\b(?:cancel|changed my mind|not interested|no thanks|ayoko|wag na|huwag na|hindi na|do not make|don't make)\b/i.test(text)) {
            current = { ...EMPTY_REQUEST, request_evidence: text.slice(0, 500), request_evidence_message_id: message.id || null };
            continue;
        }
        // A request for samples means viewing previous work, never production intent.
        if (/\b(?:samples?|portfolio|examples?)\b/i.test(text) && !/\b(?:concept|script)\b/i.test(text)) continue;
        if (/^\s*(?:how much|magkano|hm\b|what (?:is|are|s|the).{0,20}(?:price|cost)|can you (?:tell|explain)|i (?:want|would like|need) to (?:know|learn|see|ask|inquire))\b/i.test(text)) continue;
        const type = requestType(text);
        const explicit = /\b(?:i (?:want|would like|need)|i'd like|we (?:want|would like|need)|can (?:i|we) (?:get|have|request)|can you (?:make|create|write|prepare)|please (?:make|create|write|prepare|send)|send me|pahingi|(?:gusto|gusto ko|gusto namin|gusto kong)|pagawa|papagawa|magpapagawa|paki(?:gawa|send)|gawan|request(?:ing)?|proceed|go ahead)\b/i.test(text);
        const nextStep = /\b(?:concept|script)\b\s+(?:(?:na|muna|please|pls|po|sana)\s*)+$/i.test(text) || /^\s*(?:free\s+)?(?:concept|script)\s*(?:po|please|pls)?[.!]*\s*$/i.test(text);
        const acceptance = /^(?:(?:yes|yes please|yes po|opo|oo|sige|sige po|okay|ok|go ahead|proceed)[,! .]*)+$/i.test(text);
        const offered = requestType(lastPageText);
        // An acknowledgement is acceptance only after an actual choice/permission
        // question about making the authorized output, never after price alone.
        const explicitOffer = /\?/.test(lastPageText) && /\b(?:would you like|do you want|want (?:a|the|to)|like (?:a|the|to)|gusto|gawan|pagawa|shall (?:i|we)|proceed|simulan|start)\b/i.test(lastPageText) && !/\b(?:sample|portfolio)\b/i.test(lastPageText);
        const acceptedType = type && (explicit || nextStep) ? type : acceptance && explicitOffer ? offered : null;
        if (acceptedType) current = { has_clear_request: true, request_type: acceptedType,
            request_evidence: text.slice(0, 500), request_evidence_message_id: message.id || null };
        lastPageText = '';
    }
    return current;
}

export function hasClearVideoRequest(history: FacebookMessage[], pageId: string): boolean {
    return extractClearVideoRequest(history, pageId).has_clear_request;
}

export function resolveCommercialVideoRequest(input: {
    history?: FacebookMessage[]; pageId: string; inboundMessage?: string;
    hasClearRequest?: boolean; requestType?: CommercialVideoRequestType | null; requestEvidence?: string | null;
    requestCandidate?: unknown;
}): CommercialVideoRequest {
    const history = [...(input.history || [])];
    if (input.inboundMessage?.trim() && !history.some(message => message.from?.id !== input.pageId && message.message?.trim() === input.inboundMessage?.trim())) {
        history.push({ id: '__current_customer_intake__', from: { id: '__customer__', name: '' }, message: input.inboundMessage.trim(), created_time: new Date().toISOString() });
    }
    const observed = extractClearVideoRequest(history, input.pageId);
    if (observed.has_clear_request) return observed;
    if (observed.request_evidence) return observed;
    // The model may resolve contextual references ("Proceed with that please"),
    // but its candidate must contain actual customer request language and a
    // verbatim quote. Merely returning has_clear_request never creates intent.
    const candidate = input.requestCandidate as Partial<CommercialVideoRequest> | null | undefined;
    const evidence = typeof candidate?.request_evidence === 'string' ? candidate.request_evidence.trim() : '';
    const evidenceMessage = evidence && history.find(message => message.from?.id !== input.pageId && message.message?.includes(evidence));
    if (candidate?.has_clear_request === true &&
        ['commercial_video', 'free_concept', 'free_script'].includes(candidate.request_type || '') &&
        evidence.length > 0 && evidence.length <= 500 && evidenceMessage &&
        /\b(?:want|need|would like|please|request|proceed|go ahead|tuloy|simulan|gusto|gawan|pagawa|papagawa|pahingi|pakigawa|pakisend)\b/i.test(evidence) &&
        !/^\s*(?:how much|magkano|hm\b|what .{0,20}(?:price|cost)|i (?:want|would like|need) to (?:know|learn|see|ask|inquire))\b/i.test(evidenceMessage.message) &&
        !(/\b(?:sample|portfolio|example)s?\b/i.test(evidenceMessage.message) && !/\b(?:concept|script)\b/i.test(evidenceMessage.message))) {
        return { has_clear_request: true, request_type: candidate.request_type as CommercialVideoRequestType,
            request_evidence: evidence, request_evidence_message_id: evidenceMessage.id || null };
    }
    const latest = input.inboundMessage || history.filter(message => message.from?.id !== input.pageId).sort((a, b) => Date.parse(b.created_time) - Date.parse(a.created_time))[0]?.message || '';
    if (/\b(?:cancel|changed my mind|not interested|no thanks|ayoko|wag na|huwag na|hindi na|do not make|don't make)\b/i.test(latest)) return { ...EMPTY_REQUEST };
    return input.hasClearRequest === true
        ? { has_clear_request: true, request_type: input.requestType || null, request_evidence: input.requestEvidence || null }
        : observed;
}
