/** Copy comparison ignores politeness and layout, but keeps numbers and
 * negation so an updated quote or correction is never treated as a duplicate. */
import { containsCommercialVideoForm } from '@/lib/chatbot-intake';

export class ChatbotFollowUpRepeatedError extends Error {}

export function comparableChatbotCopy(text: string): string {
    return text.toLowerCase().normalize('NFKC')
        .replace(/\b(?:po|opo|please|ninyo|ninyong|nyo|your|the|ang|ng|sa)\b/g, ' ')
        .replace(/\b(?:kindly|paki)\s+/g, '')
        .replace(/\b(?:pakisend|pakishare|provide|share|ibigay)\b/g, 'send')
        .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function isRepeatedChatbotCopy(left: string, right: string): boolean {
    const label = (text: string) => text.match(/(?:^|\n)(Business Name|Business Location|Goal ng video|Contact Number):/)?.[1];
    if (label(left) && label(right) && label(left) !== label(right)) return false;
    const a = comparableChatbotCopy(left), b = comparableChatbotCopy(right);
    if (!a || !b) return false;
    if (a === b) return true;
    const facts = (text: string) => [...text.matchAll(/\d+|\b(?:no|not|never|hindi|wala|walang)\b/g)].map(match => match[0]).sort().join(' ');
    if (facts(a) !== facts(b)) return false;
    const wordsA = new Set(a.split(' ')), wordsB = new Set(b.split(' '));
    if (Math.min(wordsA.size, wordsB.size) < 4) return false;
    // Catch an old sentence embedded in a new paragraph or a moved bubble break.
    if (a.includes(b) || b.includes(a)) return true;
    const shared = [...wordsA].filter(word => wordsB.has(word)).length;
    return shared / Math.max(wordsA.size, wordsB.size) >= 0.82;
}

export function uniqueChatbotCopy(parts: string[]): string[] {
    const result: string[] = [];
    for (const part of parts.map(text => text.trim()).filter(Boolean)) {
        if (!result.some(previous => isRepeatedChatbotCopy(part, previous))) result.push(part);
    }
    return result;
}

/** Keep natural sentences and explicit paragraphs separate. Decimal prices and
 * abbreviations within words do not introduce an artificial sentence boundary. */
export function splitConversationalCopy(source: string): string[] {
    return source.trim().split(/\n+/).flatMap(paragraph =>
        paragraph.split(/(?<!\b(?:Mr|Mrs|Ms|Dr|Jr|Sr|St|No|Inc|Corp|e\.g|i\.e)\.)(?<=[.!?])\s+(?=[\p{L}\d])/iu)
    ).map(part => part.trim()).filter(Boolean);
}

type RepetitionOptions = { allowRepeatedFormsAndSamples?: boolean };

function repetitionUnits(text: string, options: RepetitionOptions): string[] {
    if (!options.allowRepeatedFormsAndSamples) return [text, ...splitConversationalCopy(text)];
    const form = containsCommercialVideoForm(text);
    const lines = text.split(/\r?\n/).filter(line => !form || (
        !/^\s*[1-4][.)]\s*(?:Business Name|Business Location|Goal ng video|Contact Number):/i.test(line) &&
        !/(?:para maihanda|pakisagutan ang kulang).*(?:concept|script|details|request)|walang bayad.*walang kailangang bilhin/i.test(line)
    ));
    return lines.flatMap(splitConversationalCopy).filter(part => {
        // Reusable portfolio descriptions are not promotional pitches. Keep
        // questions and offers in comparison even beside an allowed form/sample.
        const sampleDescription = /^(?:[\p{L}][\p{L}\p{M}' .-]*,\s*)?(?:ito|heto|here|these)\b.*\b(?:samples?|portfolio)\b/iu.test(part);
        return !sampleDescription || /\?|\b(?:free|libre|concept|script|offer|avail|promo|gusto|proceed)\b/i.test(part);
    });
}

export function hasRepeatedChatbotCopy(parts: string[], previous: string[], options: RepetitionOptions = {}): boolean {
    const priorUnits = previous.flatMap(text => repetitionUnits(text, options));
    const units = options.allowRepeatedFormsAndSamples ? parts.flatMap(text => repetitionUnits(text, options)) : parts;
    return units.some((part, index) =>
        priorUnits.some(old => isRepeatedChatbotCopy(part, old)) ||
        units.slice(0, index).some(old => isRepeatedChatbotCopy(part, old))
    );
}
