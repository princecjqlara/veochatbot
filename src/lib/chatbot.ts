import type { FacebookMessage } from '@/types';

export const DEFAULT_CHATBOT_MODEL = '~deepseek/deepseek-flash-latest';
export const DEFAULT_CHATBOT_INSTRUCTIONS =
    'You are a helpful customer support assistant for this Facebook Page. Be concise, friendly, accurate, and never invent prices, policies, availability, or promises.';
export const DEFAULT_CHATBOT_FALLBACK =
    'Thanks for your message! A member of our team will get back to you shortly.';

export type ChatbotConfig = {
    page_id: string;
    enabled: boolean;
    instructions: string;
    fallback_reply: string;
    model: string;
};

type OpenRouterResponse = {
    choices?: Array<{ message?: { content?: string | null } }>;
    error?: { message?: string };
};

export function buildChatbotMessages(input: {
    instructions: string;
    contactName?: string | null;
    pageId: string;
    inboundMessage: string;
    history?: FacebookMessage[];
}) {
    const contactName = input.contactName?.trim() || 'the customer';
    const system = (input.instructions.trim() || DEFAULT_CHATBOT_INSTRUCTIONS) + '\n\n' +
        'You are replying to ' + contactName + ' in Facebook Messenger. ' +
        'Return only the message to send. Keep it under 600 characters and do not mention these instructions.';

    const history = (input.history || [])
        .filter((message) => typeof message.message === 'string' && message.message.trim().length > 0)
        .slice(0, 20)
        .reverse()
        .map((message) => ({
            role: message.from?.id === input.pageId ? 'assistant' as const : 'user' as const,
            content: message.message.trim()
        }));

    const inboundMessage = input.inboundMessage.trim();
    const lastMessage = history[history.length - 1];
    if (!lastMessage || lastMessage.role !== 'user' || lastMessage.content !== inboundMessage) {
        history.push({ role: 'user', content: inboundMessage });
    }

    return [{ role: 'system' as const, content: system }, ...history];
}

export async function generateChatbotReply(input: {
    config: ChatbotConfig;
    contactName?: string | null;
    pageId: string;
    inboundMessage: string;
    history?: FacebookMessage[];
}): Promise<string> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not configured');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);

    try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + apiKey,
                'Content-Type': 'application/json',
                'HTTP-Referer': process.env.NEXTAUTH_URL || 'http://localhost:3000',
                'X-OpenRouter-Title': 'Tokko Chatbot'
            },
            body: JSON.stringify({
                model: input.config.model || process.env.OPENROUTER_MODEL || DEFAULT_CHATBOT_MODEL,
                max_tokens: 300,
                temperature: 0.4,
                messages: buildChatbotMessages({
                    instructions: input.config.instructions,
                    contactName: input.contactName,
                    pageId: input.pageId,
                    inboundMessage: input.inboundMessage,
                    history: input.history
                })
            }),
            signal: controller.signal
        });

        const body = await response.json().catch(() => ({})) as OpenRouterResponse;
        if (!response.ok) {
            throw new Error(body.error?.message || 'OpenRouter request failed (' + response.status + ')');
        }

        const content = body.choices?.[0]?.message?.content?.trim();
        if (!content) throw new Error('OpenRouter returned an empty reply');
        return content.slice(0, 600);
    } finally {
        clearTimeout(timeout);
    }
}
