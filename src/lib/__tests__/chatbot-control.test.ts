import { describe, expect, it } from 'vitest';
import {
    CHATBOT_CONVERSATION_WINDOW_MS,
    classifyChatbotStopIntent,
    getRequiredChatbotDetailCount,
    getChatbotStateStopReason,
    getMissingChatbotDetails,
    normalizeDetailsToCollect,
    type ChatbotContactState
} from '@/lib/chatbot-control';

describe('chatbot conversation controls', () => {
    it('rounds percentage detail targets up to a whole required field', () => {
        expect(getRequiredChatbotDetailCount(5, 40)).toBe(2);
        expect(getRequiredChatbotDetailCount(3, 40)).toBe(2);
        expect(getRequiredChatbotDetailCount(5, 100)).toBe(5);
        expect(getRequiredChatbotDetailCount(0, 40)).toBe(0);
    });

    it('normalizes unique detail names and reports only missing values', () => {
        const requested = normalizeDetailsToCollect([' Full name ', 'Mobile number', 'full name', '']);
        expect(requested).toEqual(['Full name', 'Mobile number']);
        expect(getMissingChatbotDetails(requested, { 'Full name': 'CJ Lara' }))
            .toEqual(['Mobile number']);
    });

    it('detects explicit opt-outs before softer sales refusals', () => {
        expect(classifyChatbotStopIntent('Please stop messaging me', {
            stopOnOptOut: true,
            stopOnRefusal: true
        })).toBe('opt_out');
        expect(classifyChatbotStopIntent('No thanks, not interested', {
            stopOnOptOut: true,
            stopOnRefusal: true
        })).toBe('refusal');
        expect(classifyChatbotStopIntent('No thanks, not interested', {
            stopOnOptOut: true,
            stopOnRefusal: false
        })).toBeNull();
    });

    it('stops an active bot state when its fixed seven-day lifecycle expires', () => {
        const startedAt = new Date('2026-09-01T00:00:00Z');
        const state: ChatbotContactState = {
            page_id: 'page-1',
            contact_id: 'contact-1',
            status: 'active',
            started_at: startedAt.toISOString(),
            window_expires_at: new Date(startedAt.getTime() + CHATBOT_CONVERSATION_WINDOW_MS).toISOString(),
            collected_details: {},
            missing_details: [],
            stop_reason: null,
            stopped_at: null,
            last_inbound_at: null,
            last_bot_reply_at: null
        };

        expect(getChatbotStateStopReason(state, new Date('2026-09-07T23:59:00Z'))).toBeNull();
        expect(getChatbotStateStopReason(state, new Date('2026-09-08T00:00:00Z'))).toBe('window_expired');
    });
});
