import { randomUUID } from 'node:crypto';

type Coordinator = { rpc: Function };
type Phase = 'salary' | 'operations';

/** Shared cadence survives cold starts. Failed work backs off in the database;
 * a lost completion can only delay this optional phase until its lease expires.
 */
export async function runMaintenancePhase<T extends { error?: unknown }>(db: Coordinator, phase: Phase, operation: () => Promise<T>): Promise<T | { skipped: true; reason: 'maintenance_not_due' }> {
    const owner = randomUUID();
    const claim = await db.rpc('veo_claim_maintenance_phase', { p_phase: phase, p_owner: owner });
    if (claim.error) throw Error('Maintenance scheduling is temporarily unavailable');
    if (claim.data !== true) return { skipped: true, reason: 'maintenance_not_due' };
    let success = false;
    try {
        const result = await operation();
        success = !result.error;
        return result;
    } finally {
        try {
            const finished = await db.rpc('veo_finish_maintenance_phase', { p_phase: phase, p_owner: owner, p_success: success });
            if (finished.error || finished.data !== true) console.warn('[MAINTENANCE_PHASE] Completion will recover on expiry', { phase });
        } catch { console.warn('[MAINTENANCE_PHASE] Completion will recover on expiry', { phase }); }
    }
}
