import { describe, expect, it } from 'vitest';
import { choosePositiveOutcomeTag } from './messaging-auto-tag-worker';

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
