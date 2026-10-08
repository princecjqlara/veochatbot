import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    classifyMessengerSystemMessage,
    findLatestMessengerLeadStageEvent,
    findLatestMessengerSystemSignal,
    loadMessengerHistoryForStopCheck
} from './messaging-auto-tag';

describe('classifyMessengerSystemMessage', () => {
    it('accepts qualified, not-qualified, and converted stage records', () => {
        expect(classifyMessengerSystemMessage('Lead stage set to Qualified')).toBe('qualified');
        expect(classifyMessengerSystemMessage('Lead stage set to Not Qualified')).toBe('not_qualified');
        expect(classifyMessengerSystemMessage('Lead stage set to Disqualified.')).toBe('not_qualified');
        expect(classifyMessengerSystemMessage('Lead stage set to Converted')).toBe('converted');
        expect(classifyMessengerSystemMessage('Lead stage set to Order Created')).toBe('order_created');
    });

    it('accepts explicit created and requested order notifications', () => {
        expect(classifyMessengerSystemMessage('You created an order for PHP699. View: fb-pma://payments/orderdetails/?invoice_id=12345')).toBe('order_created');
        expect(classifyMessengerSystemMessage('You requested PHP699. View: fb-pma://payments/orderdetails/?invoice_id=12345')).toBe('order_created');
    });

    it.each(['Intake', 'Contacted', 'Interested', 'Custom Stage'])(
        'treats an explicit %s stage as a durable human handoff', (stage) => {
            expect(classifyMessengerSystemMessage(`Lead stage set to ${stage}`)).toBe('manual');
            expect(findLatestMessengerLeadStageEvent([{ id: 'stage-event', message: `Lead stage set to ${stage}`,
                from: { id: 'page-1' } }], 'page-1')?.signal).toBe('manual');
        }
    );

    it('recognizes the Unqualified alias without matching ordinary stage discussion', () => {
        expect(classifyMessengerSystemMessage('Lead stage set to Unqualified.')).toBe('not_qualified');
        expect(classifyMessengerSystemMessage('Please set the lead stage to Contacted')).toBeNull();
    });

    it('does not mistake payment claims or ordinary text for a qualifying event', () => {
        expect(classifyMessengerSystemMessage('I paid PHP699')).toBeNull();
        expect(classifyMessengerSystemMessage('You created an order for PHP699')).toBeNull();
    });

    it('finds the newest Lead Center stage written by the Page', () => {
        expect(findLatestMessengerSystemSignal([
            {
                message: 'Lead stage set to Qualified',
                from: { id: 'page-1' },
                created_time: '2026-09-25T10:00:00Z'
            },
            {
                message: 'Lead stage set to Converted',
                from: { id: 'page-1' },
                created_time: '2026-09-26T10:00:00Z'
            }
        ], 'page-1')).toBe('converted');
    });

    it('ignores stage-like text sent by a customer', () => {
        expect(findLatestMessengerSystemSignal([{
            message: 'Lead stage set to Qualified',
            from: { id: 'customer-1' },
            created_time: '2026-09-26T10:00:00Z'
        }], 'page-1')).toBeNull();
    });

    it('returns audit metadata for the newest explicit lead-stage change', () => {
        expect(findLatestMessengerLeadStageEvent([
            {
                id: 'stage-old',
                message: 'Lead stage set to Qualified',
                from: { id: 'page-1' },
                created_time: '2026-09-28T10:00:00Z'
            },
            {
                id: 'stage-new',
                message: 'Lead stage set to Converted',
                from: { id: 'page-1' },
                created_time: '2026-09-29T10:00:00Z'
            },
            {
                id: 'order-event',
                message: 'You created an order for PHP699. View: fb-pma://payments/orderdetails/?invoice_id=12345',
                from: { id: 'page-1' },
                created_time: '2026-09-29T11:00:00Z'
            }
        ], 'page-1')).toEqual({
            messageId: 'stage-new',
            signal: 'converted',
            createdTime: '2026-09-29T10:00:00Z'
        });
    });
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('Messenger lead-stage pagination', () => {
    it('rejects an unavailable initial history page when checking automatic delivery', async () => {
        await expect(loadMessengerHistoryForStopCheck({ facebookPageId: 'page-1', accessToken: 'token',
            initialPage: null, requireAvailable: true })).rejects.toThrow('history is unavailable');
    });
    it('finds an older handoff outside the newest history page without sending anything', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{
            message: 'Lead stage set to Converted', from: { id: 'page-1' }
        }] }) });
        vi.stubGlobal('fetch', fetchMock);
        const messages = await loadMessengerHistoryForStopCheck({
            facebookPageId: 'page-1', accessToken: 'secret',
            initialPage: { data: [{ message: 'Thanks', from: { id: 'customer' } }], paging: { next: 'https://graph.facebook.com/thread/messages?after=older&access_token=old-secret' } }
        });
        expect(findLatestMessengerSystemSignal(messages, 'page-1')).toBe('converted');
        expect(fetchMock).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ headers: { Authorization: 'Bearer secret' } }));
        expect(fetchMock.mock.calls[0][0].searchParams.has('access_token')).toBe(false);
    });

    it('fails closed if older history cannot be checked completely', async () => {
        await expect(loadMessengerHistoryForStopCheck({
            facebookPageId: 'page-1', accessToken: 'token', maxPages: 1,
            initialPage: { data: [], paging: { next: 'https://graph.facebook.com/thread/messages?after=older' } }
        })).rejects.toThrow('safe limit');
    });

    it('rejects pagination to other hosts', async () => {
        await expect(loadMessengerHistoryForStopCheck({
            facebookPageId: 'page-1', accessToken: 'token',
            initialPage: { data: [], paging: { next: 'https://other.example/messages' } }
        })).rejects.toThrow('pagination URL');
    });
});
