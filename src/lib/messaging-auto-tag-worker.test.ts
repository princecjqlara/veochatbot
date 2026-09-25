import { describe, expect, it } from 'vitest';
import {
    buildMessengerOutcomeTagRows,
    choosePositiveOutcomeTag,
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
