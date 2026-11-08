import { expect, it, vi } from 'vitest';
import { cleanupWorkspacePhotos } from '../veo-photo-cleanup';
function database(removeError: unknown = null) {
    const writes: any[] = [], reads: string[] = [];
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: 'submission-' + i, object_path: 'photo-' + i, status: i % 2 ? 'delivered' : 'queued' }));
    const orphans = Array.from({ length: 30 }, (_, i) => ({ object_path: 'orphan-' + i }));
    const db = { from: vi.fn((table: string) => {
        const q: any = { select: () => q, is: () => q, or: () => q, lte: () => q,
            limit: async () => { reads.push(table); return { data: table === 'veo_submissions' ? rows : orphans }; },
            update: (values: any) => { writes.push({ table, values }); return q; }, in: async (field: string, ids: string[]) => {
                Object.assign(writes.at(-1), { field, ids }); return { error: null };
            } };
        return q;
    }), storage: { from: () => ({ remove: vi.fn() }) } };
    const remove = vi.fn().mockResolvedValue({ error: removeError });
    db.storage.from = () => ({ remove });
    return { db, writes, reads, remove };
}
it('cleans 60 objects with two storage calls and four checkpoint writes', async () => {
    const { db, writes, reads, remove } = database();
    await cleanupWorkspacePhotos(db);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove.mock.calls.map(([paths]) => paths.length)).toEqual([30, 30]);
    expect(reads).toHaveLength(2); expect(writes).toHaveLength(4);
    const delivered = writes.find(row => row.table === 'veo_submissions' && !row.values.status);
    const expired = writes.find(row => row.values.status === 'expired');
    expect(delivered.ids).toHaveLength(15); expect(expired.ids).toHaveLength(15);
    expect(delivered.ids).not.toEqual(expired.ids);
});
it('does not acknowledge storage deletions that failed', async () => {
    const { db, writes, remove } = database({ message: 'unavailable' });
    await expect(cleanupWorkspacePhotos(db)).rejects.toThrow('Temporary photo deletion pending');
    expect(remove).toHaveBeenCalledOnce(); expect(writes).toHaveLength(0);
});
