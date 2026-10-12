import { describe, expect, it, vi } from 'vitest';
import { assignMessengerOutcomeTags, buildMessengerOutcomeTagRows } from '@/lib/messenger-outcome-tags';

function fixture(options: { missing?: boolean; defaultError?: boolean } = {}) {
    let tags = options.missing ? [] : buildMessengerOutcomeTagRows('page-1').map(row => ({ ...row, id: row.system_key }));
    const assignments: Array<{ contact_id: string; tag_id: string }> = [];
    const from = vi.fn((table: string) => {
        let defaults = false;
        const chain: any = {
            select: () => chain,
            eq: (key: string) => { if (key === 'is_default') defaults = true; return chain; },
            in: () => chain, order: () => chain, limit: () => chain,
            upsert: async (rows: any[], settings: Record<string, unknown>) => {
                if (table === 'tags') tags = rows.map(row => ({ ...row, id: row.system_key }));
                else {
                    expect(settings).toEqual({ onConflict: 'contact_id,tag_id', ignoreDuplicates: true });
                    assignments.push(...rows);
                }
                return { error: null };
            },
            then: (resolve: any) => Promise.resolve(defaults
                ? { data: [{ id: 'legacy', name: 'Unqualified' }, { id: 'paid', name: 'Paid / Availed Service' }], error: options.defaultError ? { message: 'Defaults unavailable' } : null }
                : { data: tags, error: null }).then(resolve)
        };
        return chain;
    });
    return { db: { from }, assignments };
}

describe('immediate Messenger outcome tagging', () => {
    it.each(['qualified', 'converted', 'order_created'])('assigns %s and the positive default to the observed contact', async stage => {
        const { db, assignments } = fixture();
        await assignMessengerOutcomeTags(db, 'page-1', 'contact-1', stage);
        expect(assignments).toEqual([{ contact_id: 'contact-1', tag_id: stage }, { contact_id: 'contact-1', tag_id: 'paid' }]);
    });

    it('assigns a negative outcome without a paid tag', async () => {
        const { db, assignments } = fixture();
        await assignMessengerOutcomeTags(db, 'page-1', 'contact-1', 'not_qualified');
        expect(assignments).toEqual([{ contact_id: 'contact-1', tag_id: 'not_qualified' }]);
    });

    it('creates missing system tags before assignment', async () => {
        const { db, assignments } = fixture({ missing: true });
        await assignMessengerOutcomeTags(db, 'page-1', 'contact-1', 'qualified');
        expect(assignments).toContainEqual({ contact_id: 'contact-1', tag_id: 'qualified' });
    });

    it('keeps the outcome assignment when the optional default tag lookup fails', async () => {
        const { db, assignments } = fixture({ defaultError: true });
        await expect(assignMessengerOutcomeTags(db, 'page-1', 'contact-1', 'qualified')).rejects.toMatchObject({ message: 'Defaults unavailable' });
        expect(assignments).toEqual([{ contact_id: 'contact-1', tag_id: 'qualified' }]);
    });

    it('does not label a generic staff handoff as an outcome', async () => {
        const { db } = fixture();
        await assignMessengerOutcomeTags(db, 'page-1', 'contact-1', 'engaged');
        expect(db.from).not.toHaveBeenCalled();
    });
});
