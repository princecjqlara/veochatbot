import { getSupabaseAdmin } from './supabase';
import { jaucianRead } from './veo-jaucian';

export async function syncTelegramWorkforce() {
    const db = getSupabaseAdmin(), claim = await db.rpc('veo_claim_telegram_sync');
    if (claim.error) throw new Error('Telegram sync scheduling unavailable');
    if (!claim.data) return { due: false };
    const job = claim.data;
    try {
        const observations = await jaucianRead(job.tenant_id, { resource: 'workforce', offset: String(job.cursor || 0), limit: '8' });
        const applied = await db.rpc('veo_apply_telegram_observations', { p_tenant: job.tenant_id, p_payload: observations });
        if (applied.error) throw new Error('Telegram observations could not be reconciled');
        return { due: true, ...applied.data };
    } catch {
        const saved = await db.from('veo_telegram_sync_state').update({ last_error: 'Telegram verification unavailable; no accounts removed from unknown membership', lease_until: null, next_sync_at: new Date(Date.now() + 120000).toISOString() }).eq('tenant_id', job.tenant_id);
        if (saved.error) throw new Error('Telegram sync failure checkpoint unavailable');
        return { due: true, retry: true };
    }
}
