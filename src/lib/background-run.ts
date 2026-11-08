/** Coalesce overlapping invocations in a warm worker. Queue item leases remain
 * the authority for coordination across separate serverless instances. */
const active = new Set<string>();
export async function runBackgroundJob<T>(name: string, operation: () => Promise<T>): Promise<T | { skipped: true; reason: 'already_running' }> {
    if (active.has(name)) return { skipped: true, reason: 'already_running' };
    active.add(name);
    try { return await operation(); }
    finally { active.delete(name); }
}
