/** Versioned commercial-video form. Display labels also remain the persisted keys
 * so existing detail collectors can read the answers without a second store. */
export const COMMERCIAL_VIDEO_FORM_VERSION = 1;
export const COMMERCIAL_VIDEO_FIELDS = [
    { key: 'business_name', label: 'Business Name', aliases: ['business name', 'company name', 'business/company name', 'pangalan ng negosyo'] },
    { key: 'business_location', label: 'Business Location', aliases: ['business location', 'business address', 'company address', 'location', 'address', 'lokasyon ng negosyo'] },
    { key: 'video_goal', label: 'Goal ng video', aliases: ['goal ng video', 'video goal', 'video objective', 'goal of video', 'goal of the video', 'video purpose', 'purpose of video', 'what is the purpose of the commercial video', 'purpose', 'objective'] },
    { key: 'contact_number', label: 'Contact Number', aliases: ['contact number', 'phone number', 'mobile number', 'telephone number', 'phone', 'mobile', 'contact no', 'contact no.'] }
] as const;
export type CommercialVideoFieldKey = typeof COMMERCIAL_VIDEO_FIELDS[number]['key'];
export const COMMERCIAL_VIDEO_REQUIRED_DETAILS = COMMERCIAL_VIDEO_FIELDS.map(field => field.label);
export type CommercialVideoIntakeAction = 'send_form' | 'ask_missing_field' | 'clarify_next_step' | 'handoff' | 'none';

export function normalizeCommercialVideoIntakeConfig<T extends {
    commercial_video_intake_enabled?: boolean; details_to_collect?: string[]; details_completion_percent?: number;
    continuation_review_hour?: number; continuation_review_minute?: number; stop_when_details_collected?: boolean;
}>(config: T): T {
    if (config.commercial_video_intake_enabled !== true) return config;
    return { ...config, details_to_collect: [...COMMERCIAL_VIDEO_REQUIRED_DETAILS], details_completion_percent: 100,
        continuation_review_hour: 23, continuation_review_minute: 59, stop_when_details_collected: false };
}

const placeholder = /^(?:unknown|not (?:provided|specified|stated|yet provided|yet specified)|n\/?a|none|null|undefined|pending|tbd|to be (?:confirmed|determined)|not sure|unsure|hindi pa alam|wala(?: pa)?|[-?]+)[.!?\s]*$/i;
const keyText = (value: string) => value.trim().toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ');

export function normalizeCommercialVideoDetails(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const entries = Object.entries(value as Record<string, unknown>);
    const normalized: Record<string, string> = {};
    for (const field of COMMERCIAL_VIDEO_FIELDS) {
        // Exact labels/canonical keys take precedence over ambiguous old aliases.
        const aliases = [field.label, field.key, ...field.aliases].map(keyText);
        for (const alias of [...new Set(aliases)]) {
            const entry = entries.find(([key, answer]) => keyText(key) === alias && typeof answer === 'string' && answer.trim() && !placeholder.test(answer.trim()));
            if (!entry || typeof entry[1] !== 'string') continue;
            let answer = entry[1].trim().replace(/[\t ]+/g, ' ').slice(0, 500);
            if (field.key === 'contact_number') {
                const digits = answer.replace(/\D/g, '');
                if (!/^[+\d\s().\-]+$/.test(answer) || digits.length < 7 || digits.length > 15 || /^(\d)\1+$/.test(digits)) continue;
                answer = `${answer.startsWith('+') ? '+' : ''}${digits}`;
            }
            normalized[field.label] = answer;
            break;
        }
    }
    return normalized;
}

export function getMissingCommercialVideoDetails(value: unknown): string[] {
    const details = normalizeCommercialVideoDetails(value);
    return COMMERCIAL_VIDEO_REQUIRED_DETAILS.filter(label => !details[label]);
}

/** A request for a video identifies the service, not its business objective.
 * Keep saved goals; accept new goals only in the customer's own words. */
export function mergeCommercialVideoChatDetails(existing: unknown, candidate: unknown, customerTexts: string[]): Record<string, string> {
    const saved = normalizeCommercialVideoDetails(existing);
    const proposed = normalizeCommercialVideoDetails(candidate);
    const comparable = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const goal = proposed['Goal ng video'];
    const serviceOnly = goal && /\bcommercial video\b/i.test(goal) && !/promot|awareness|brand|sell|sales|benta|customers|leads|inquir|launch|showcase|ipakita|introduce|explain|announce|recruit|educat|inform/i.test(goal);
    if (goal && goal !== saved['Goal ng video'] && (serviceOnly || !customerTexts.some(text => comparable(text).includes(comparable(goal))))) delete proposed['Goal ng video'];
    return { ...saved, ...proposed };
}

export function renderCommercialVideoForm(details?: unknown): string {
    const collected = normalizeCommercialVideoDetails(details);
    return COMMERCIAL_VIDEO_REQUIRED_DETAILS.map((label, index) => (index + 1) + '. ' + label + ':' + (collected[label] ? ' ' + collected[label].replace(/\s+/g, ' ') : '')).join('\n');
}

export function containsCommercialVideoForm(content: string): boolean {
    return COMMERCIAL_VIDEO_REQUIRED_DETAILS.every((label, index) => content.includes(`${index + 1}. ${label}:`));
}

/** Shared by runtime prompts and the explicit saved-settings rollout. */
export const COMMERCIAL_VIDEO_OWNER_POLICY_MARKER = 'Natural follow-up and free-concept sales policy (2026-10-21):';
export const COMMERCIAL_VIDEO_OWNER_POLICY = [
    COMMERCIAL_VIDEO_OWNER_POLICY_MARKER,
    'Natural Taglish, no emojis, verified first name only; no surnames, sir, maam, boss or invented names.',
    'Flow: ask business -> relevant existing sample -> duration -> verified pricing and seven-step process -> buying question -> form. Continue from history; answer direct questions first.',
    'Split ordinary sentences into natural Messenger bubbles. Keep full pricing, the entire process plus revision note, and all four form fields each in ONE separate message, exempt from part caps. Follow with one relevant question.',
    'Process: PHP150 down payment; business details, photos/videos, logo and contact; script for approval; approved script becomes AI commercial video; watermarked preview for checking/revision; final payment after approval; final video without watermark plus FREE poster ads after full payment. PHP100 per revision only for additions outside the approved script after video completion.',
    'Use the same verified knowledge and portfolio. Give the selected-duration rate, distinguishing total, deposit and balance. Never invent quotes, send multiple package prices, or promise free personalized videos.',
    'Require Business Name, Business Location, Goal ng video, Contact Number (100%). Save answers/corrections. Prefill forms and ask one missing field. Forms and relevant existing samples may repeat when useful or requested; never ask known fields.',
    'Free concept/script remain free, no purchase required. Explicit free requests can go straight to intake. Form completion, sample/price inquiry, silence or thanks are not buying consent.',
    'Explain with every form and pricing message that a free concept is available without payment or purchase. Paid-video prices and deposits apply only to paid production.',
    'Summarize complete answers once, clarify next step or honor a clear request for team handoff. Avoid repeated greetings, pitches, unchanged summaries and near-identical question/reminder construction; politeness changes are not fresh wording.',
    'Preserve Page switches, schedules, explicit lead-stage stops, staff holds, opt-outs, refusals and messaging windows. At 23:59 Asia/Manila automatically resume eligible temporary staff pauses only when the customer has neither availed/agreed to a paid video nor accepted a free concept/script. Missing details do not reopen an accepted request.'
].join(' ');

export function commercialVideoPolicyPrompt(details: unknown): string {
    const collected = normalizeCommercialVideoDetails(details);
    return '\n\nCOMMERCIAL VIDEO INTAKE POLICY (takes precedence over older Page or knowledge offer copy):\n' +
        COMMERCIAL_VIDEO_OWNER_POLICY + '\n' +
        'Verified saved answers: ' + JSON.stringify(collected) + '. Missing: ' + (getMissingCommercialVideoDetails(collected).join(', ') || 'none') + '. ' +
        'Only explicit customer answers and their latest corrections count. Business type, Messenger name, Page name, and product brands are not the actual Business Name. A city or real area is enough for location; Contact Number must be usable. Record Goal ng video only when the customer states the purpose, using their own words verbatim. A business type, duration, or request for a commercial video is not a video goal. Leave it missing until answered. ' +
        'Before sending the form, keep the sales flow on business, sample, duration, pricing and process; never force a missing-form-field question into these earlier steps. After the form is introduced, ask one still-missing field and rotate ignored questions. Never ask a known field. ' +
        'Use po naturally, plain text and relaxed phrasing. No stiff translations, canned assistant openers, fake enthusiasm, AI signatures or provider branding. Numbered lists and labels are allowed for the form, pricing and process. Ordinary replies should be brief; structured blocks must remain complete. ' +
        'Production previews have a watermark for checking; final videos have no watermark after full payment. Do not confuse these customer deliverables with forbidden AI signatures in chat. ' +
        'When all four fields are complete, never resend a blank form. Honor an explicit commercial-video, free-concept or free-script request. Accepting a free output is not agreement to buy a video; never seek a quote or charge for free concept/script. ' +
        'Return intake_action (send_form|ask_missing_field|clarify_next_step|handoff|none), has_clear_request, request_type (commercial_video|free_concept|free_script|null), and request_evidence (exact customer quote or null) in JSON. Only explicit customer consent creates a request.\n';
}

/** Saved policy copies are for the settings UI. Runtime has one authoritative
 * intake policy, so do not send the same block in every owner field. */
export function commercialVideoOwnerGuidance(text: string): string {
    const markers = [COMMERCIAL_VIDEO_OWNER_POLICY_MARKER, 'Business sample duration and single-message sales policy (2026-10-21):', 'Form incentive and sentence splitting policy (2026-10-18):', 'Compact form-first conversation policy (2026-10-18):', 'Form-first split and follow-up policy (2026-10-18):',
        'Form-first summary and pricing policy (2026-10-17):', 'Form-first follow-up update (2026-10-17):',
        'Current owner language and message policy (2026-10-17):', 'Current commercial-video intake policy:'];
    const positions = markers.map(marker => text.indexOf(marker)).filter(index => index >= 0);
    return (positions.length ? text.slice(0, Math.min(...positions)) : text)
        .replace(/Use at most one emoji\.?/gi, '')
        .replace(/Use the saved first name only when natural, not in every reply\.?/gi, '')
        .replace(/Send a relevant sample only when requested or needed to answer the inquiry\.?/gi, '')
        .replace(/Do not send unsolicited samples or repeated media\.?/gi, '')
        .replace(/Do not ask unrelated discovery questions while required intake details are missing\.?/gi, '')
        .replace(/Do not divert incomplete intake into offer choices, optional duration\/budget\/style questions, repeated pitches, or a generic form reminder\.?/gi, '')
        .replace(/Ask at most one useful question only when information is needed\.?/gi, '')
        .replace(/Do not attach answers, questions, or offers to the form message\.?/gi, '')
        .replace(/without repeating earlier copy or samples/gi, 'without repeating pitches or near-identical questions and reminders')
        .trim();
}

/** Multiple package prices are a catalog. Deposit/balance figures for one
 * selected package remain a useful answer and are not a package list. */
export function hasCommercialVideoPriceList(text: string): boolean {
    const money = /(?:₱|\bPHP\s*|\bP\s*)(?:\d[\d,]*)(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s*(?:pesos|PHP)\b/gi;
    const offers = text.split(/\n|;|(?<=[.!?])\s+/).filter(clause => !/\b(?:deposit|down\s*payment|balance|discount|previous|original|revisions?)\b/i.test(clause));
    if ((offers.join(' ').match(money) || []).length > 1) return true;
    return (text.match(/\b\d+\s*(?:s|secs?|seconds?|segundo|mins?|minutes?)\b\s*[:=–—-]?\s*(?:(?:₱|PHP|P)\s*)?\d[\d,]*/gi) || []).length > 1;
}

export function hasForbiddenFreePreproductionCharge(content: string): boolean {
    return content.split(/(?<=[.!?\n])\s*/).some(clause => {
        if (/\b(?:no\s+(?:fee|charge|cost|payment|quote)|not\s+(?:charged|paid)|without\s+(?:charge|payment|fee)|walang\s+(?:bayad|charge|fee)|hindi.*(?:bayad|charge))\b/i.test(clause)) return false;
        return /\b(?:quote|quotation|charge|fee|payment|price|cost|rate|bayad|presyo)\s+(?:para\s+sa|for|of|ng|sa)\s+(?:(?:inyong|your|the)\s+)?free\s+(?:concept|script)\b/i.test(clause);
    });
}

/** Reject conflicting model promises; the caller can retry rather than send them. */
export function hasForbiddenFreeVideoOffer(content: string): boolean {
    const clauses = content.split(/(?<=[.!?\n])\s*/);
    return clauses.some(clause => {
        if (!/\b(?:free|libre|libreng|walang bayad)\b/i.test(clause)) return false;
        if (/\b(?:not free|no free|never|cannot|can't|don't|do not|hindi|di po|walang free|hindi libre|hindi po libre)\b/i.test(clause)) return false;
        if (/\b(?:portfolio|previous work|past work|existing samples?|existing work|past samples?|previous samples?)\b/i.test(clause) && !/\b(?:personalized|personalised|custom|gagawa|gawan|create|make|produce)\b/i.test(clause)) return false;
        return /\b(?:free|libre|libreng|walang bayad)\b[^.!?\n]{0,55}\b(?:personalized|personalised|custom|sample|video|commercial)\b/i.test(clause
            .replace(/\b(?:free|libre|libreng)\s+(?:video\s+)?(?:concept|script)\b/gi, 'authorized offer')
            .replace(/\b(?:free|libre|libreng)\s+(?:poster(?:\s+ads?)?|ad\s+posters?)\b/gi, 'included poster')) ||
            /\b(?:personalized|personalised|custom|sample|video|commercial)\b[^.!?\n]{0,55}\b(?:for free|libre|libreng|walang bayad)\b/i.test(clause);
    });
}
