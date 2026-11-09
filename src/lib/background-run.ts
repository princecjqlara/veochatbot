import { randomUUID } from 'node:crypto';
import { getSupabaseAdmin } from './supabase';
/** Item leases protect delivery; this lease also prevents duplicate cron
 * maintenance across serverless instances for longer-than-one-minute runs. */
const active = new Set<string>();
export async function runBackgroundJob<T>(name: string, operation: () => Promise<T>, coordinator?: { rpc: Function }): Promise<T | { skipped: true; reason: 'already_running' }> {
    if (active.has(name)) return { skipped: true, reason: 'already_running' };
    active.add(name);
    let db = coordinator || null;
    const owner = randomUUID(); let claimed = false;
    try {
        if (!db && process.env.VEO_WORKSPACE_ENABLED === 'true' && ['workspace', 'contact-profiles'].includes(name)) db = getSupabaseAdmin();
        if (db) {
            const lease = await db.rpc('veo_claim_background_job', { p_job: name, p_owner: owner });
            if (lease.error) throw new Error('Background coordination is temporarily unavailable');
            if (!lease.data) return { skipped: true, reason: 'already_running' };
            claimed = true;
        }
        return await operation();
    } finally {
        if (db && claimed) {
            try { const released = await db.rpc('veo_release_background_job', { p_job: name, p_owner: owner }); if (released.error) console.warn('[BACKGROUND_JOB] Lease release will recover on expiry', { name }); }
            catch { console.warn('[BACKGROUND_JOB] Lease release will recover on expiry', { name }); }
        }
        active.delete(name);
    }
}
