import { describe, expect, it, vi } from 'vitest';
import { assignMessengerOutcomeTags } from './messenger-outcome-tags';

describe('preserved stage outcome tags', () => {
    it('assigns the existing stage tag without a paid tag for a generic staff handoff', async () => {
        const assignments: unknown[] = [];
        const defaultRead = vi.fn();
        const db = { from: (table: string) => {
            let defaults = false;
            const chain: any = {
                select: () => chain,
                eq: (key: string) => { if (key === 'is_default') { defaults = true; defaultRead(); } return chain; },
                in: () => chain, order: () => chain, limit: () => chain,
                upsert: async (rows: unknown) => { assignments.push(rows); return { error: null }; },
                then: (resolve: any) => Promise.resolve({ data: defaults ? [{ id: 'paid', name: 'Paid / Availed Service' }] : [
                    { id: 'qualified-tag', system_key: 'qualified' }, { id: 'converted-tag', system_key: 'converted' },
                    { id: 'order-tag', system_key: 'order_created' }, { id: 'not-qualified-tag', system_key: 'not_qualified' }
                ], error: null }).then(resolve)
            };
            if (table === 'contact_tags') return chain;
            return chain;
        } };
        await assignMessengerOutcomeTags(db, 'page', 'contact', 'qualified', { includePositiveTag: false });
        expect(assignments).toEqual([[{ contact_id: 'contact', tag_id: 'qualified-tag' }]]);
        expect(defaultRead).not.toHaveBeenCalled();
    });
});
