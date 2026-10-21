import { describe, expect, it } from 'vitest';
import { COMMERCIAL_DURATION_CHOICES, COMMERCIAL_FORM_PAYLOAD, getCommercialVideoMessageControls, resolveChatbotAction } from '@/lib/chatbot-interactions';
import { extractClearVideoRequest, resolveCommercialVideoRequest } from '@/lib/chatbot-policy';
import { buildChatbotTestMessages } from '@/lib/chatbot-test-preview';
import { commercialVideoCustomerTexts, containsCommercialVideoForm, getMissingCommercialVideoDetails, mergeCommercialVideoChatDetails, normalizeCommercialVideoDetails, renderCommercialVideoForm } from '@/lib/chatbot-intake';

describe('interactive commercial-video intake', () => {
    it('adds the form button to the proceed question without putting buttons on the process or quote', () => {
        expect(getCommercialVideoMessageControls(['PRICING PARA SA BAKERY\nPHP899', 'STEP-BY-STEP PROCESS PO:\n1. Down payment', 'CJ, gusto mo bang mag-proceed sa commercial video para masend ko ang form?']))
            .toEqual([{ message_index: 2, buttons: [{ title: 'Fill out form', payload: COMMERCIAL_FORM_PAYLOAD }] }]);
    });
    it('shows every requested duration as a clickable option and preserves the one-minute value', () => {
        expect(getCommercialVideoMessageControls(['Ilang seconds ang gusto mo?'])[0].quick_replies?.map(choice => choice.title)).toEqual(['16s', '20s', '24s', '30s', '1 min']);
        expect(resolveChatbotAction('VEO:DURATION:60')?.message).toBe('60 seconds');
        expect(COMMERCIAL_DURATION_CHOICES.every(choice => choice.title.length <= 20)).toBe(true);
        expect(resolveChatbotAction('VEO:DURATION:99999')).toBeNull();
    });
    it('treats a form click as intake rather than production consent', () => {
        const action = resolveChatbotAction(COMMERCIAL_FORM_PAYLOAD)!;
        const request = extractClearVideoRequest([{ id: 'click', from: { id: 'customer', name: 'CJ' }, message: action.message, created_time: '2026-10-21T01:00:00Z' }], 'page');
        expect(request.has_clear_request).toBe(false);
        expect(resolveCommercialVideoRequest({ pageId: 'page', inboundMessage: action.message, requestCandidate: { has_clear_request: true, request_type: 'commercial_video', request_evidence: action.message } }).has_clear_request).toBe(false);
        const submission = 'Business Name: CJ Bakery\nGoal ng Video: I want to make people try our bread\nPreferred Style: Cinematic';
        expect(resolveCommercialVideoRequest({ pageId: 'page', inboundMessage: submission, requestCandidate: { has_clear_request: true, request_type: 'commercial_video', request_evidence: 'I want to make people try our bread' } }).has_clear_request).toBe(false);
    });
    it('renders the exact eight-field form without numbering in one intact block', () => {
        expect(renderCommercialVideoForm()).toBe('Kindly fill out these details:\n\nBusiness Name:\nPage / Social Media Link:\nLocation:\nGoal ng Video:\nPreferred Video Length:\nPreferred Style:\nContact Number:\nPortrait or Landscape?');
        expect(containsCommercialVideoForm(renderCommercialVideoForm())).toBe(true);
        expect(getMissingCommercialVideoDetails({})).toHaveLength(8);
    });
    it('retains legacy location and goal answers while accepting the new display labels and no-page answer', () => {
        expect(normalizeCommercialVideoDetails({ Location: 'Manila', 'Goal ng Video': 'Promote bread', 'Page / Social Media Link': 'Wala pa', 'Preferred Video Length': '1 min', orientation: 'Vertical' })).toEqual({
            'Business Location': 'Manila', 'Goal ng video': 'Promote bread', 'Page / Social Media Link': 'Wala pa', 'Preferred Video Length': '60 seconds', 'Portrait or Landscape?': 'Portrait'
        });
    });
    it('prefills a chosen duration and does not revert it from stale history', () => {
        expect(mergeCommercialVideoChatDetails({}, {}, ['24 seconds'], '24 seconds')['Preferred Video Length']).toBe('24 seconds');
        expect(mergeCommercialVideoChatDetails({ 'Preferred Video Length': '30 seconds' }, {}, ['16 seconds'], 'Pakisend ng form')['Preferred Video Length']).toBe('30 seconds');
        const history = [{ message: '30 seconds', from: { id: 'customer' }, created_time: '2026-10-21T01:01:00Z' }, { message: '16 seconds', from: { id: 'customer' }, created_time: '2026-10-21T01:00:00Z' }];
        expect(commercialVideoCustomerTexts(history, 'page')).toEqual(['16 seconds', '30 seconds']);
        expect(mergeCommercialVideoChatDetails({}, { 'Preferred Style': 'Cinematic', 'Page / Social Media Link': 'https://example.com/invented', 'Preferred Video Length': '30 seconds' }, ['Hi po'], 'Hi po')).toEqual({});
    });
    it('keeps simulated duration choices on the question after the actual sample carousel', () => {
        const messages = buildChatbotTestMessages({ messages: ['Ito ang samples.', 'Ilang seconds ang gusto mo?'], media_items: [{ id: 'sample', title: 'Bakery', media_type: 'video' }] }, { idPrefix: 'turn', commercialVideoIntake: true });
        expect(messages[1].mediaItems).toHaveLength(1);
        expect(messages[2].quickReplies).toEqual(COMMERCIAL_DURATION_CHOICES);
    });
});
