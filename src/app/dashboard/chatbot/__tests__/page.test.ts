import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import ChatbotPage from '../page';
import { COMMERCIAL_FORM_PAYLOAD, getCommercialVideoMessageControls } from '@/lib/chatbot-interactions';
import { renderCommercialVideoForm } from '@/lib/chatbot-intake';
import { renderCommercialVideoMessages } from '@/lib/chatbot-message-renderer';

const { session } = vi.hoisted(() => ({ session: { user: { id: 'owner' } } }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: session }) }));
vi.mock('@/lib/supabase', () => ({ getSupabaseClient: vi.fn() }));

const config = {
    page_id: 'sama', enabled: false, commercial_video_intake_enabled: true,
    instructions: '', fallback_reply: '', model: 'test', rag_enabled: true,
    follow_up_prompt: '', details_to_collect: [], details_completion_percent: 100,
    bot_dos: '', bot_donts: '', follow_up_enabled: false,
    follow_up_quick_delays_minutes: [], follow_up_best_time_days: [], follow_up_messages: [],
    follow_up_ai_instructions: '', follow_up_utility_text: '',
    split_messages: true, max_message_parts: 0
};
const blankForm = 'Kindly fill out these details:\n\nBusiness Name:\nPage / Social Media Link:\nLocation:\nGoal ng Video:\nPreferred Video Length:\nPreferred Style:\nContact Number:\nPortrait or Landscape?';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const text = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(text).join('');

describe('Test Chat button interactions', () => {
    let view: ReactTestRenderer;
    let reply: Mock<[Record<string, any>], Response | Promise<Response>>;
    let requests: Array<Record<string, any>>;

    beforeEach(async () => {
        requests = [];
        reply = vi.fn<[Record<string, any>], Response | Promise<Response>>((body) => {
            const messages = renderCommercialVideoMessages({
                parts: [], details: body.collected_details, action: 'send_form',
                customerMessage: body.message, contactName: body.contact_name,
                salesFlow: { step: 'form', business: null, durationSeconds: null, sampleSent: false, sampleHandled: false, processSent: false, pricingSent: false, formSent: false, formRequested: true, processRequested: false }
            });
            return json({ messages, collected_details: body.collected_details });
        });
        vi.stubGlobal('window', { setTimeout, clearTimeout });
        vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
            if (options?.method === 'POST') {
                const body = JSON.parse(String(options.body));
                requests.push(body);
                return reply(body);
            }
            if (url === '/api/pages') return json({ pages: [{ id: 'sama', name: 'SAMA KANA MEDIA' }] });
            if (url === '/api/pages/sama/chatbot') return json({ config, provider: { configured: true } });
            return json({});
        }));
        await act(async () => {
            view = create(createElement(ChatbotPage), { createNodeMock: () => ({ scrollIntoView: vi.fn(), setAttribute: vi.fn() }) });
        });
        await act(async () => { view.root.findAllByType('button').find(button => text(button) === 'Test chatbot')!.props.onClick(); });
    });

    afterEach(() => {
        act(() => { view?.unmount(); });
        vi.unstubAllGlobals();
    });

    const formButton = () => view.root.findByProps({ 'aria-label': 'Open full intake form' });
    const chatBubbles = () => view.root.findAllByType('p').filter(node => node.props.className === 'whitespace-pre-wrap').map(text);
    const typeMessage = async (message: string) => {
        await act(async () => { view.root.findByProps({ 'aria-label': 'Test customer message' }).props.onChange({ target: { value: message } }); });
        await act(async () => { view.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() }); });
    };

    it('opens all eight fields in one bubble from an empty chat while the live bot is OFF', async () => {
        expect(formButton().props.disabled).toBe(false);
        await act(async () => { formButton().props.onClick(); });
        expect(requests[0]).toEqual(expect.objectContaining({
            action_payload: COMMERCIAL_FORM_PAYLOAD, message: 'Pakisend ng fill-up form.', history: [], collected_details: {},
            draft_config: expect.objectContaining({ enabled: false })
        }));
        const bubbles = chatBubbles();
        expect(bubbles.filter(message => message.includes('Kindly fill out'))).toHaveLength(1);
        expect(bubbles.at(-2)).toContain(blankForm);
        expect(bubbles.at(-1)).toMatch(/business.*\?$/i);
    });

    it('clicks the proceed button and reopens the whole prefilled form without losing a draft', async () => {
        const details = { 'Business Name': 'Miguel Bakery', 'Preferred Video Length': '30 seconds' };
        const messages = ['PRICING PARA SA MIGUEL BAKERY\nPHP899', 'Gusto mo bang mag-proceed para masend ko ang form?'];
        reply.mockReturnValueOnce(json({ messages, collected_details: details, message_controls: getCommercialVideoMessageControls(messages) }));
        await typeMessage('30 seconds');
        await act(async () => { view.root.findByProps({ 'aria-label': 'Test customer message' }).props.onChange({ target: { value: 'My unsent question' } }); });
        const inlineButton = view.root.findAllByType('button').find(button => text(button) === 'Fill out form' && !button.props['aria-label'])!;
        expect(inlineButton).toBeDefined();
        await act(async () => { inlineButton.props.onClick(); });
        expect(requests[1].collected_details).toEqual(details);
        expect(requests[1].history).toContainEqual({ role: 'user', content: '30 seconds' });
        expect(chatBubbles().at(-2)).toContain(renderCommercialVideoForm(details));
        expect(chatBubbles().at(-1)).toMatch(/page|social/i);
        await act(async () => { formButton().props.onClick(); });
        expect(chatBubbles().at(-2)).toContain(renderCommercialVideoForm(details));
        expect(view.root.findByProps({ 'aria-label': 'Test customer message' }).props.value).toBe('My unsent question');
    });

    it('keeps duration choices available after a failed request and disables them while retrying', async () => {
        const messages = ['Ito ang bakery sample.', 'Ilang seconds ang gusto mo?'];
        reply.mockReturnValueOnce(json({ messages, collected_details: {}, message_controls: getCommercialVideoMessageControls(messages) }));
        await typeMessage('Bakery');
        reply.mockReturnValueOnce(json({ error: 'Please retry' }, 500));
        const durationButton = () => view.root.findAllByType('button').find(button => text(button) === '30s')!;
        await act(async () => { durationButton().props.onClick(); });
        expect(durationButton().props.disabled).toBe(false);
        expect(chatBubbles()).not.toContain('30s');
        let finish!: (response: Response) => void;
        reply.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
        await act(async () => { durationButton().props.onClick(); });
        expect(durationButton().props.disabled).toBe(true);
        expect(formButton().props.disabled).toBe(true);
        await act(async () => { finish(json({ messages: ['Gusto mo bang mag-proceed para masend ko ang form?'], collected_details: { 'Preferred Video Length': '30 seconds' } })); });
        expect(requests[2].action_payload).toBe('VEO:DURATION:30');
        expect(view.root.findAllByType('button').some(button => text(button) === '30s')).toBe(false);
        expect(formButton().props.disabled).toBe(false);
    });
});
