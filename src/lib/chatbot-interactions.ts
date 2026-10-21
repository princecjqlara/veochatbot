export type ChatbotChoice = { title: string; payload: string };
export type ChatbotMessageControls = { message_index: number; buttons?: ChatbotChoice[]; quick_replies?: ChatbotChoice[] };
export const COMMERCIAL_FORM_PAYLOAD = 'VEO:FORM:2';
export const COMMERCIAL_DURATION_CHOICES: ChatbotChoice[] = [16, 20, 24, 30, 60].map(seconds => ({
    title: seconds === 60 ? '1 min' : `${seconds}s`, payload: `VEO:DURATION:${seconds}`
}));

/** Only app-owned actions map to conversation text. Opening a form is not buying consent. */
export function resolveChatbotAction(payload: unknown): { title: string; message: string } | null {
    if (payload === COMMERCIAL_FORM_PAYLOAD) return { title: 'Fill out form', message: 'Pakisend ng fill-up form.' };
    const duration = COMMERCIAL_DURATION_CHOICES.find(choice => choice.payload === payload);
    if (duration) return { title: duration.title, message: `${duration.payload.split(':').at(-1)} seconds` };
    if (payload === 'VEO:ORIENTATION:PORTRAIT') return { title: 'Portrait', message: 'Portrait ang preferred format ko.' };
    if (payload === 'VEO:ORIENTATION:LANDSCAPE') return { title: 'Landscape', message: 'Landscape ang preferred format ko.' };
    return null;
}

/** Attach controls to the actual question, never to a long pricing/process/form block. */
export function getCommercialVideoMessageControls(messages: string[]): ChatbotMessageControls[] {
    const message_index = messages.length - 1;
    const question = messages[message_index] || '';
    if (!/\?\s*$/.test(question)) return [];
    if (/(?:ilang|gaano|how|preferred|anong|ano|may).{0,75}(?:seconds?|segundo|duration|haba|length|katagal)|(?:duration|length).{0,45}\?/i.test(question)) {
        return [{ message_index, quick_replies: COMMERCIAL_DURATION_CHOICES }];
    }
    if (/portrait|landscape|vertical|horizontal|orientation/i.test(question)) return [{ message_index, quick_replies: [
        { title: 'Portrait', payload: 'VEO:ORIENTATION:PORTRAIT' }, { title: 'Landscape', payload: 'VEO:ORIENTATION:LANDSCAPE' }
    ] }];
    if (/proceed|simulan|ready.*form|sagutan.*form|(?:send|masend|ibigay).*form/i.test(question)) {
        return [{ message_index, buttons: [{ title: 'Fill out form', payload: COMMERCIAL_FORM_PAYLOAD }] }];
    }
    return [];
}
