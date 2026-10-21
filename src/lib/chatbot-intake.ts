/** Versioned commercial-video form. Display labels also remain the persisted keys
 * so existing detail collectors can read the answers without a second store. */
export const COMMERCIAL_VIDEO_FORM_VERSION = 2;
export const COMMERCIAL_VIDEO_FIELDS = [
    { key: 'business_name', label: 'Business Name', displayLabel: 'Business Name', aliases: ['business name', 'company name', 'business/company name', 'pangalan ng negosyo'] },
    { key: 'social_media_link', label: 'Page / Social Media Link', displayLabel: 'Page / Social Media Link', aliases: ['page link', 'social media link', 'facebook page', 'facebook page link', 'page url', 'social link'] },
    { key: 'business_location', label: 'Business Location', displayLabel: 'Location', aliases: ['business location', 'business address', 'company address', 'location', 'address', 'lokasyon ng negosyo'] },
    { key: 'video_goal', label: 'Goal ng video', displayLabel: 'Goal ng Video', aliases: ['goal ng video', 'video goal', 'video objective', 'goal of video', 'goal of the video', 'video purpose', 'purpose of video', 'what is the purpose of the commercial video', 'purpose', 'objective'] },
    { key: 'preferred_video_length', label: 'Preferred Video Length', displayLabel: 'Preferred Video Length', aliases: ['video length', 'preferred duration', 'video duration', 'duration', 'length'] },
    { key: 'preferred_style', label: 'Preferred Style', displayLabel: 'Preferred Style', aliases: ['video style', 'style', 'preferred video style'] },
    { key: 'contact_number', label: 'Contact Number', displayLabel: 'Contact Number', aliases: ['contact number', 'phone number', 'mobile number', 'telephone number', 'phone', 'mobile', 'contact no', 'contact no.'] },
    { key: 'orientation', label: 'Portrait or Landscape?', displayLabel: 'Portrait or Landscape?', aliases: ['portrait or landscape', 'orientation', 'video orientation', 'video format', 'format', 'aspect ratio'] }
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
const keyText = (value: string) => value.trim().toLowerCase().replace(/[?:]+$/, '').replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ');

export function normalizeCommercialVideoDetails(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const entries = Object.entries(value as Record<string, unknown>);
    const normalized: Record<string, string> = {};
    for (const field of COMMERCIAL_VIDEO_FIELDS) {
        // Exact labels/canonical keys take precedence over ambiguous old aliases.
        const aliases = [field.label, field.displayLabel, field.key, ...field.aliases].map(keyText);
        for (const alias of [...new Set(aliases)]) {
            const entry = entries.find(([key, answer]) => keyText(key) === alias && typeof answer === 'string' && answer.trim() &&
                (!placeholder.test(answer.trim()) || field.key === 'social_media_link' && /^(?:wala(?: pa)?|none|n\/?a)[.!?\s]*$/i.test(answer.trim())));
            if (!entry || typeof entry[1] !== 'string') continue;
            let answer = entry[1].trim().replace(/[\t ]+/g, ' ').slice(0, 500);
            if (field.key === 'preferred_video_length') {
                const seconds = commercialVideoDurationSeconds(answer);
                if (!seconds) continue;
                answer = seconds + ' seconds';
            }
            if (field.key === 'orientation') {
                if (/portrait|vertical|9\s*:\s*16/i.test(answer) && /landscape|horizontal|16\s*:\s*9/i.test(answer)) continue;
                if (/portrait|vertical|9\s*:\s*16/i.test(answer)) answer = 'Portrait';
                else if (/landscape|horizontal|16\s*:\s*9/i.test(answer)) answer = 'Landscape';
                else continue;
            }
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

function customerOrientation(text: string): 'Portrait' | 'Landscape' | null {
    const field = text.match(/^(?:portrait or landscape\??|(?:video )?(?:orientation|format))\s*:?\s*([^\r\n]*)$/im);
    const standalone = /^\s*(?:portrait|landscape|vertical|horizontal|9\s*:\s*16|16\s*:\s*9)(?:\s+(?:po|please))?[.!]?\s*$/i.test(text);
    if (!field && !standalone && !/preferred.{0,25}(?:format|orientation)|(?:format|orientation).{0,25}(?:gusto|preferred)|(?:portrait|landscape).{0,30}(?:format|orientation|gusto)/i.test(text)) return null;
    const answer = field ? field[1] : text;
    const portrait = /\b(?:portrait|vertical)\b|9\s*:\s*16/i.test(answer);
    const landscape = /\b(?:landscape|horizontal)\b|16\s*:\s*9/i.test(answer);
    return portrait === landscape ? null : portrait ? 'Portrait' : 'Landscape';
}

/** A request for a video identifies the service, not its business objective.
 * Keep saved goals; accept new goals only in the customer's own words. */
export function mergeCommercialVideoChatDetails(existing: unknown, candidate: unknown, customerTexts: string[], currentCustomerText?: string): Record<string, string> {
    const saved = normalizeCommercialVideoDetails(existing);
    const proposed = normalizeCommercialVideoDetails(candidate);
    const comparable = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const goal = proposed['Goal ng video'];
    const serviceOnly = goal && /\bcommercial video\b/i.test(goal) && !/promot|awareness|brand|sell|sales|benta|customers|leads|inquir|launch|showcase|ipakita|introduce|explain|announce|recruit|educat|inform/i.test(goal);
    if (goal && goal !== saved['Goal ng video'] && (serviceOnly || !customerTexts.some(text => comparable(text).includes(comparable(goal))))) delete proposed['Goal ng video'];
    for (const label of ['Page / Social Media Link', 'Preferred Style']) {
        const answer = proposed[label]?.replace(/^https?:\/\/(?:www\.)?/i, '');
        if (answer && proposed[label] !== saved[label] && !customerTexts.some(text => comparable(text).includes(comparable(answer)))) delete proposed[label];
    }
    if (proposed['Preferred Video Length'] && proposed['Preferred Video Length'] !== saved['Preferred Video Length'] &&
        !customerTexts.some(text => commercialVideoDurationSeconds(text) === commercialVideoDurationSeconds(proposed['Preferred Video Length']))) delete proposed['Preferred Video Length'];
    if (proposed['Portrait or Landscape?'] && proposed['Portrait or Landscape?'] !== saved['Portrait or Landscape?'] &&
        !customerTexts.some(text => customerOrientation(text) === proposed['Portrait or Landscape?'])) delete proposed['Portrait or Landscape?'];
    const merged = { ...saved, ...proposed };
    let inferredSeconds: number | null = null;
    let inferredOrientation: string | null = null;
    for (const text of customerTexts) {
        const withoutLinks = text.replace(/https?:\/\/\S+/g, '');
        const seconds = commercialVideoDurationSeconds(withoutLinks);
        if (seconds && !/\?/.test(withoutLinks) && !/sample|example|reference|add.on/i.test(withoutLinks)) inferredSeconds = seconds;
        inferredOrientation = customerOrientation(withoutLinks) || inferredOrientation;
    }
    if (!merged['Preferred Video Length'] && inferredSeconds) merged['Preferred Video Length'] = inferredSeconds + ' seconds';
    if (!merged['Portrait or Landscape?'] && inferredOrientation) merged['Portrait or Landscape?'] = inferredOrientation;
    const current = currentCustomerText?.replace(/https?:\/\/\S+/g, '') || '';
    const currentSeconds = !/\?|sample|example|reference|add.on/i.test(current) ? commercialVideoDurationSeconds(current) : null;
    if (currentSeconds) merged['Preferred Video Length'] = currentSeconds + ' seconds';
    else if (saved['Preferred Video Length']) merged['Preferred Video Length'] = saved['Preferred Video Length'];
    const currentOrientation = customerOrientation(current);
    if (currentOrientation) merged['Portrait or Landscape?'] = currentOrientation;
    return merged;
}

export function commercialVideoCustomerTexts(history: Array<{ message?: string; created_time?: string; from?: { id?: string } }>, pageId: string, inbound?: string): string[] {
    const ordered = [...history];
    if (ordered.every(message => Number.isFinite(Date.parse(message.created_time || '')))) ordered.sort((a, b) => Date.parse(a.created_time!) - Date.parse(b.created_time!));
    else ordered.reverse();
    const texts = ordered.filter(message => message.from?.id !== pageId && message.message?.trim()).map(message => message.message!);
    if (inbound?.trim() && texts.at(-1) !== inbound.trim()) texts.push(inbound.trim());
    return texts;
}

export function commercialVideoDurationSeconds(text: string): number | null {
    const matches = [...text.matchAll(/\b(\d{1,3}(?:\.\d+)?)[\s-]*(s(?:ec(?:ond)?s?)?|segundos?|mins?|minutes?|minutos?)\b/gi)];
    const match = matches.at(-1);
    if (!match) return null;
    const seconds = Number(match[1]) * (/^min/i.test(match[2]) ? 60 : 1);
    return seconds > 0 && seconds <= 600 ? seconds : null;
}

export function renderCommercialVideoForm(details?: unknown): string {
    const collected = normalizeCommercialVideoDetails(details);
    return 'Kindly fill out these details:\n\n' + COMMERCIAL_VIDEO_FIELDS.map(({ label, displayLabel }) =>
        displayLabel + (displayLabel.endsWith('?') ? '' : ':') + (collected[label] ? ' ' + collected[label].replace(/\s+/g, ' ') : '')).join('\n');
}

export function containsCommercialVideoForm(content: string): boolean {
    return content.includes('Kindly fill out these details:') && COMMERCIAL_VIDEO_FIELDS.every(({ displayLabel }) => content.includes(displayLabel + (displayLabel.endsWith('?') ? '' : ':')));
}

export function containsLegacyCommercialVideoForm(content: string): boolean {
    return ['Business Name', 'Business Location', 'Goal ng video', 'Contact Number'].every(label => new RegExp('(?:^|\\n)(?:[1-4][.)]\\s*)?' + label + ':', 'i').test(content));
}

/** Shared by runtime prompts and the explicit saved-settings rollout. */
export const COMMERCIAL_VIDEO_OWNER_POLICY_MARKER = 'Interactive eight-field video intake policy (2026-10-21):';
export const COMMERCIAL_VIDEO_OWNER_POLICY = [
    COMMERCIAL_VIDEO_OWNER_POLICY_MARKER,
    'Natural Taglish, no emojis, verified first name only; no surnames, titles or invented names.',
    'Flow: business -> existing relevant sample -> duration choices -> verified price and full process -> proceed question with Fill out form button -> form on click. Continue history; answer direct questions first.',
    'Split ordinary sentences. Full pricing, process plus revision note, and eight-field form each stay in ONE message without caps, then one relevant question. The app adds buttons; never print payloads.',
    'Process: PHP150 down payment; business details, photos/videos, logo, contact; script approval; approved script becomes AI commercial video; watermarked preview for checking/revision; final payment after approval; final without watermark plus FREE poster ads after full payment. PHP100 revisions only for additions outside the approved script after video completion.',
    'Keep verified knowledge and samples. Quote only the selected duration; distinguish total/deposit/balance. No invented quotes, price catalogs or free personalized videos.',
    'Exact Kindly fill out these details form: Business Name; Page / Social Media Link; Location; Goal ng Video; Preferred Video Length; Preferred Style; Contact Number; Portrait or Landscape? Require all eight; retain old answers, prefill chosen length, ask one missing field. Never ask known fields. Useful/requested forms and samples may repeat.',
    'Clickable lengths: 16s, 20s, 24s, 30s, 1 min; accept typed lengths. These are preferences, not approved quotes. A form click only requests the form, never paid/free output consent.',
    'Free concept/script need no payment or purchase; direct form/free requests can enter intake. Forms, samples, price inquiries, silence and thanks are not buying consent.',
    'Every form and pricing message explains the free concept needs no fee/purchase. Paid production alone has prices/deposits.',
    'Summarize complete answers once; clarify next step or honor explicit team handoff. No repeated greetings/pitches/unchanged summaries or near-identical questions/reminders; politeness changes are not fresh wording.',
    'Preserve Page switches, schedules, lead-stage stops, staff holds, opt-outs, refusals and messaging windows. At 23:59 Asia/Manila resume eligible temporary staff pauses only with no paid-video agreement and no accepted free concept/script. Missing fields never reopen an accepted request.'
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
        'When all eight fields are complete, never resend a blank form. Honor an explicit commercial-video, free-concept or free-script request. Accepting a free output or clicking a form button is not agreement to buy a video; never seek a quote or charge for free concept/script. ' +
        'Return intake_action (send_form|ask_missing_field|clarify_next_step|handoff|none), has_clear_request, request_type (commercial_video|free_concept|free_script|null), and request_evidence (exact customer quote or null) in JSON. Only explicit customer consent creates a request.\n';
}

/** Saved policy copies are for the settings UI. Runtime has one authoritative
 * intake policy, so do not send the same block in every owner field. */
export function commercialVideoOwnerGuidance(text: string): string {
    const markers = [COMMERCIAL_VIDEO_OWNER_POLICY_MARKER, 'Natural follow-up and free-concept sales policy (2026-10-21):', 'Business sample duration and single-message sales policy (2026-10-21):', 'Form incentive and sentence splitting policy (2026-10-18):', 'Compact form-first conversation policy (2026-10-18):', 'Form-first split and follow-up policy (2026-10-18):',
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
