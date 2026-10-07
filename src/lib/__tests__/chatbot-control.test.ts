import { describe, expect, it, vi } from 'vitest';
import {
    CHATBOT_CONVERSATION_WINDOW_MS,
    classifyChatbotStopIntent,
    getRequiredChatbotDetailCount,
    getChatbotStateStopReason,
    getMissingChatbotDetails,
    isChatbotContactAllowed,
    normalizeDetailsToCollect,
    normalizeCollectedChatbotDetails,
    saveChatbotContactState,
    type ChatbotContactState
} from '@/lib/chatbot-control';

describe('chatbot conversation controls', () => {
    it('limits live trial mode to the selected contact', () => {
        expect(isChatbotContactAllowed(undefined, 'contact_1')).toBe(true);
        expect(isChatbotContactAllowed({ trial_mode_enabled: false, trial_contact_id: null }, 'contact_1')).toBe(true);
        expect(isChatbotContactAllowed({ trial_mode_enabled: true, trial_contact_id: 'contact_1' }, 'contact_1')).toBe(true);
        expect(isChatbotContactAllowed({ trial_mode_enabled: true, trial_contact_id: 'contact_1' }, 'contact_2')).toBe(false);
        expect(isChatbotContactAllowed({ trial_mode_enabled: true, trial_contact_id: null }, 'contact_1')).toBe(false);
    });

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

    it('does not count placeholder values as customer answers', () => {
        expect(getMissingChatbotDetails(['Business name', 'Script', 'Deadline'], {
            'Business name': 'unknown', Script: 'No script, please write one', Deadline: 'Not provided'
        })).toEqual(['Business name', 'Deadline']);
        expect(normalizeCollectedChatbotDetails({ ' BUSINESS NAME ': 'Example Shop', Script: 'pending', Extra: 'guess' }, ['Business name', 'Script']))
            .toEqual({ 'Business name': 'Example Shop' });
    });

    it('keeps a stopped state and original handoff time when saving late answers', async () => {
        const upsert = vi.fn().mockResolvedValue({ error: null });
        await saveChatbotContactState({ from: () => ({ upsert }) }, {
            pageId: 'page-1', contactId: 'contact-1',
            existingState: {
                status: 'stopped', stop_reason: 'qualified', stopped_at: '2026-10-01T00:00:00Z',
                collected_details: { Script: 'No script' }, started_at: '2026-10-01T00:00:00Z'
            } as unknown as ChatbotContactState,
            collectedDetails: { Deadline: 'Friday' }, missingDetails: [],
            now: new Date('2026-10-07T00:00:00Z')
        });
        expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
            status: 'stopped', stop_reason: 'qualified', stopped_at: '2026-10-01T00:00:00Z',
            collected_details: { Script: 'No script', Deadline: 'Friday' }
        }), expect.anything());
    });

    it('only updates active rows when saving from an older active snapshot', async () => {
        const eq = vi.fn(() => chain);
        const chain: any = { update: vi.fn(() => chain), eq,
            then: (resolve: any, reject: any) => Promise.resolve({ error: null }).then(resolve, reject)
        };
        await saveChatbotContactState({ from: () => chain }, {
            pageId: 'page', contactId: 'contact',
            existingState: { status: 'active', collected_details: {}, started_at: '2026-10-01T00:00:00Z' } as ChatbotContactState,
            collectedDetails: { Deadline: 'Friday' }
        });
        expect(eq).toHaveBeenCalledWith('status', 'active');
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
