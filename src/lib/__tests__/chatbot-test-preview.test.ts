import { describe, expect, it } from 'vitest';
import { buildChatbotTestMessages, getChatbotTestHistory, type TestChatMessage } from '@/lib/chatbot-test-preview';
import { renderCommercialVideoForm } from '@/lib/chatbot-intake';
import { renderCommercialVideoProcess } from '@/lib/chatbot-message-renderer';

const sample = { id: 'bakery-video', title: 'Bakery commercial', media_type: 'video' as const, target_url: 'https://example.com/bakery' };
const folder = { id: 'folder', name: 'Bakery samples', folder_url: 'https://example.com/samples', button_text: 'View samples' };
const options = { idPrefix: 'turn-1', commercialVideoIntake: true };

describe('dashboard chatbot test preview', () => {
    it('shows the existing sample before the commercial duration question', () => {
        const sources = [{ document_id: 'bakery', title: 'Bakery portfolio', similarity: 0.9 }];
        const result = buildChatbotTestMessages({ messages: ['CJ, ito ang bakery sample namin.', 'Ilang seconds ang gusto mo?'], media_items: [sample], sources }, options);
        expect(result.map(message => message.content)).toEqual(['CJ, ito ang bakery sample namin.', '', 'Ilang seconds ang gusto mo?']);
        expect(result[1].mediaItems).toEqual([sample]);
        expect(result[2].sources).toEqual(sources);
    });

    it('uses separate follow-up bubbles instead of the merged legacy reply', () => {
        const result = buildChatbotTestMessages({ reply: 'Merged copy should not be used.', messages: ['CJ, may bakery sample kami.', 'Gusto mo bang makita?'], media: sample }, { ...options, label: 'Quick follow-up preview' });
        expect(result.map(message => message.content)).toEqual(['CJ, may bakery sample kami.', '', 'Gusto mo bang makita?']);
        expect(result.every(message => message.label === 'Quick follow-up preview')).toBe(true);
        expect(new Set(result.map(message => message.id)).size).toBe(result.length);
    });

    it('keeps pricing, all seven process steps, and the full form intact', () => {
        const process = renderCommercialVideoProcess('CJ Lara', 'CJ Cafe');
        const form = renderCommercialVideoForm({ 'Business Name': 'CJ Cafe' });
        const parts = ['CJ, 24-second main commercial video: PHP899.', process, form, 'CJ, saan located ang CJ Cafe?'];
        const result = buildChatbotTestMessages({ messages: parts }, options);
        expect(result.map(message => message.content)).toEqual(parts);
        expect(result[1].content.length).toBeGreaterThan(320);
        expect(result[2].content).toContain('Contact Number');
    });

    it('retains generic-bot ordering and the live single-bubble media ordering', () => {
        const result = buildChatbotTestMessages({ messages: ['Existing sample.', 'What do you think?'], media_items: [sample] }, { idPrefix: 'generic' });
        expect(result.map(message => message.content)).toEqual(['Existing sample.', 'What do you think?', '']);
        const single = buildChatbotTestMessages({ messages: ['Ilang seconds ang gusto mo?'], media_items: [sample] }, options);
        expect(single.map(message => message.content)).toEqual(['Ilang seconds ang gusto mo?', '']);
    });

    it('keeps a folder button on the final text bubble, including follow-ups', () => {
        const result = buildChatbotTestMessages({ messages: ['Ito ang samples namin.', 'Ano ang gusto mong style?'], media_items: [sample], folder }, options);
        expect(result.at(-1)).toEqual(expect.objectContaining({ content: 'Ano ang gusto mong style?', folder }));
        expect(result.filter(message => message.folder)).toHaveLength(1);
    });

    it('supports an older reply payload and a single media fallback', () => {
        const result = buildChatbotTestMessages({ messages: [], reply: 'Ito ang existing sample.', media_items: [], media: sample }, options);
        expect(result.map(message => message.content)).toEqual(['Ito ang existing sample.', '']);
        expect(result[1].mediaItems).toEqual([sample]);
    });

    it('excludes UI demos and media-only cards from subsequent reply and follow-up history', () => {
        const history: TestChatMessage[] = [
            { id: 'demo', role: 'assistant', content: 'UI sample demonstration.', previewOnly: true, mediaItems: [sample] },
            { id: 'user', role: 'user', content: 'Bakery ang business ko.' },
            ...buildChatbotTestMessages({ messages: ['Ito ang sample.', 'Ilang seconds?'], media_items: [sample] }, options)
        ];
        expect(getChatbotTestHistory(history)).toEqual([
            { role: 'user', content: 'Bakery ang business ko.' },
            { role: 'assistant', content: 'Ito ang sample.' },
            { role: 'assistant', content: 'Ilang seconds?' }
        ]);
        expect(getChatbotTestHistory(history.slice(0, 1))).toEqual([]);
    });
});
