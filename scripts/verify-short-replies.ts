import { createClient } from '@supabase/supabase-js';
import { generateChatbotResponse, type ChatbotConfig } from '../src/lib/chatbot';
import { readFile } from 'node:fs/promises';

async function main() {
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    const { data: configs, error } = await db.from('chatbot_configs').select('*').eq('enabled', true);
    if (error) throw error;
    const originals = JSON.parse(await readFile('../data/chatbot-settings-before-short-replies.json', 'utf8')) as ChatbotConfig[];
    for (const config of configs || []) {
        const original = originals.find(value => value.page_id === config.page_id);
        if (!original) throw new Error('Original follow-up backup is missing');
        for (const key of Object.keys(original).filter(key => key.startsWith('follow_up_') || ['split_messages', 'max_message_parts'].includes(key))) {
            if (JSON.stringify(config[key]) !== JSON.stringify((original as any)[key])) throw new Error(`Original follow-up setting was not restored: ${key}`);
        }
        if (!config.instructions.includes('under 320 characters') || /always ask multiple questions/i.test(config.bot_dos)) {
            throw new Error('Shorter normal-reply instructions were not retained');
        }
        console.log('Live settings verified', config.page_id);
        const queued = await db.from('chatbot_follow_up_jobs').select('id', { count: 'exact', head: true })
            .eq('page_id', config.page_id).in('status', ['pending', 'processing', 'ready_manual']);
        if (queued.error) throw queued.error;
        console.log('Queued follow-ups', queued.count);
    }
    if (process.argv.includes('--model-check') && configs?.[0]) {
        const result = await generateChatbotResponse({
            config: { ...configs[0], rag_enabled: false } as ChatbotConfig,
            pageId: 'simulated-page', pageName: 'Onset Media Agency', contactName: 'Ana',
            inboundMessage: 'May milk tea shop ako. Anong details kailangan para sa commercial video?', knowledge: []
        });
        if (result.messages.length !== 1 || result.reply.length > 320) throw new Error('Model response exceeded the short-reply limits');
        console.log('Simulated reply only; no Messenger delivery', JSON.stringify({ messages: result.messages, characters: result.reply.length }));
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
