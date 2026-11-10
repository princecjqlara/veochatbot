import { createHash } from 'node:crypto';

type Status = { tokenStatus: 'valid' | 'invalid' | 'unknown'; webhookStatus: 'ready' | 'incomplete' | 'unknown' };
/** Only external connection health is shared. Page access is read live first. */
export class PageConnectionCache {
    private entries = new Map<string, { expires: number; value?: Status; pending?: Promise<Status> }>();
    constructor(private capacity = 500) {}
    clear() { this.entries.clear(); }
    async read(identity: string[], read: () => Promise<Status>, fresh = false): Promise<Status> {
        const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
        const old = this.entries.get(key);
        if (old?.pending) return old.pending;
        if (!fresh && old?.value && old.expires > Date.now()) return old.value;
        for (const [id, item] of this.entries) if (!item.pending && item.expires <= Date.now()) this.entries.delete(id);
        if (this.entries.size >= this.capacity) {
            const disposable = [...this.entries].find(([, item]) => !item.pending);
            if (disposable) this.entries.delete(disposable[0]);
        }
        const entry: { expires: number; value?: Status; pending?: Promise<Status> } = { expires: 0 };
        const pending = Promise.resolve().then(read).then(value => {
            entry.value = value;
            entry.expires = Date.now() + (value.tokenStatus === 'unknown' || value.webhookStatus === 'unknown' ? 3000 : 30000);
            return value;
        }).catch(error => { this.entries.delete(key); throw error; }).finally(() => { entry.pending = undefined; });
        entry.pending = pending;
        // Never grow the cache without bound, even during a cold burst.
        if (this.entries.size < this.capacity) this.entries.set(key, entry);
        return pending;
    }
}
export const pageConnectionCache = new PageConnectionCache();
