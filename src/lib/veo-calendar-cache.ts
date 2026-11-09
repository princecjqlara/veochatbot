/** Small warm-worker cache. Callers recheck live Page and branch scope first. */
export function createCalendarCache<T>(ttlMs: number, maxEntries = 12, now = Date.now) {
    const values = new Map<string, { expires: number; value: T }>();
    const pending = new Map<string, Promise<T>>();
    return async (key: string, load: () => Promise<T>, refresh = false): Promise<T> => {
        const saved = values.get(key);
        if (!refresh && saved && saved.expires > now()) return saved.value;
        // A repeated Refresh must share the current read rather than start a storm.
        const active = pending.get(key); if (active) return active;
        values.delete(key);
        const read = load().then(value => {
            if (JSON.stringify(value).length <= 2_000_000) {
                for (const [k, row] of values) if (row.expires <= now()) values.delete(k);
                while (values.size >= maxEntries) values.delete(values.keys().next().value!);
                values.set(key, { value, expires: now() + ttlMs });
            }
            return value;
        }).finally(() => { pending.delete(key); });
        pending.set(key, read); return read;
    };
}
