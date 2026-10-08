import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getSupabaseAdmin: vi.fn(), getPageConversationsBatch: vi.fn(), recordChatbotInterruptionIfNeeded: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.getSupabaseAdmin }));
vi.mock('@/lib/facebook', () => ({ getPageConversationsBatch: mocks.getPageConversationsBatch }));
vi.mock('@/lib/outbound-message-events', () => ({ recordChatbotInterruptionIfNeeded: mocks.recordChatbotInterruptionIfNeeded }));
import {
    buildMessengerOutcomeTagRows,
    choosePositiveOutcomeTag,
    processOneMessagingAutoTagPage,
    MESSENGER_OUTCOME_TAGS
} from './messaging-auto-tag-worker';

describe('choosePositiveOutcomeTag', () => {
    it('selects the intended paid tag when legacy data contains two defaults', () => {
        expect(choosePositiveOutcomeTag([
            { id: 'unqualified', name: 'Unqualified' },
            { id: 'paid', name: 'Paid / Availed Service' }
        ])?.id).toBe('paid');
    });

    it('supports the existing plural paid tag name', () => {
        expect(choosePositiveOutcomeTag([
            { id: 'other', name: 'Unqualified' },
            { id: 'paid', name: 'Paid/Availed Services' }
        ])?.id).toBe('paid');
    });

    it('falls back deterministically and handles a missing tag', () => {
        expect(choosePositiveOutcomeTag([
            { id: 'first', name: 'Legacy default' },
            { id: 'second', name: 'Another default' }
        ])?.id).toBe('first');
        expect(choosePositiveOutcomeTag([])).toBeNull();
    });
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('durable Messenger lead-stage stops', () => {
    it.each([
        ['missing default tags', 'Qualified'], ['outcome tag failure', 'Qualified'], ['audit failure', 'Qualified'],
        ['missing default tags', 'Contacted'], ['missing default tags', 'Intake'], ['missing default tags', 'Custom Stage']
    ])(
        'stops and cancels queued follow-ups despite %s for %s', async (failure, stage) => {
            vi.clearAllMocks();
            const mutations: Array<{ table: string; payload: any }> = [];
            const db = { from: vi.fn((table: string) => {
                let payload: any;
                const lookup = () => {
                    if (table === 'pages') return { data: { id: 'page-1', fb_page_id: 'fb-page', access_token: 'token', messaging_auto_tag_checked_at: '2026-10-01T00:00:00Z', messaging_auto_tag_cursor: null }, error: null };
                    if (table === 'contacts') return { data: { id: 'contact-1', pipeline_stage: 'engaged' }, error: null };
                    if (table === 'chatbot_contact_states') return { data: null, error: null };
                    return { data: [], error: null };
                };
                const chain: any = {
                    select: vi.fn(() => chain), eq: vi.fn(() => chain), order: vi.fn(() => chain),
                    limit: vi.fn(() => chain), in: vi.fn(() => chain),
                    maybeSingle: vi.fn(async () => lookup()),
                    update: vi.fn((value: any) => { payload = value; mutations.push({ table, payload }); return chain; }),
                    upsert: vi.fn(async (value: any) => {
                        mutations.push({ table, payload: value });
                        return { error: table === 'tags' && failure === 'outcome tag failure' ? { message: 'Tag unavailable' } : null };
                    }),
                    then: (resolve: any, reject: any) => Promise.resolve(payload ? { error: null } : lookup()).then(resolve, reject)
                };
                return chain;
            }) };
            mocks.getSupabaseAdmin.mockReturnValue(db);
            mocks.getPageConversationsBatch.mockResolvedValue({ conversations: [{ id: 'thread-1', participants: { data: [{ id: 'customer', name: 'Customer' }] } }], nextCursor: null });
            mocks.recordChatbotInterruptionIfNeeded.mockImplementation(async () => {
                if (failure === 'audit failure') throw new Error('Audit unavailable');
            });
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [
                { id: 'lead-1', message: `Lead stage set to ${stage}`, from: { id: 'fb-page' }, created_time: '2026-10-07T00:00:00Z' }
            ] }) }));
            const result = await processOneMessagingAutoTagPage();
            expect(result).toMatchObject({ pages: 1, chatbotStopped: 1, pipelineMoved: 1 });
            expect(mutations).toContainEqual({ table: 'chatbot_contact_states', payload: expect.objectContaining({ status: 'stopped', stop_reason: stage === 'Qualified' ? 'qualified' : 'manual' }) });
            expect(mutations).toContainEqual({ table: 'chatbot_follow_up_jobs', payload: expect.objectContaining({ status: 'cancelled' }) });
        }
    );
});

describe('Messenger outcome tags', () => {
    it('defines a distinct tag for every supported Messenger outcome', () => {
        expect(Object.keys(MESSENGER_OUTCOME_TAGS).sort()).toEqual([
            'converted',
            'not_qualified',
            'order_created',
            'qualified'
        ]);
    });

    it('builds Page-owned cumulative tag rows with stable system keys', () => {
        expect(buildMessengerOutcomeTagRows('page-1')).toEqual(expect.arrayContaining([
            expect.objectContaining({
                owner_id: 'page-1',
                page_id: 'page-1',
                owner_type: 'page',
                is_default: false,
                system_key: 'qualified',
                name: 'Qualified'
            }),
            expect.objectContaining({ system_key: 'not_qualified', name: 'Not Qualified' }),
            expect.objectContaining({ system_key: 'converted', name: 'Converted' }),
            expect.objectContaining({ system_key: 'order_created', name: 'Order Created' })
        ]));
        expect(buildMessengerOutcomeTagRows('page-1')).toHaveLength(4);
    });
});
