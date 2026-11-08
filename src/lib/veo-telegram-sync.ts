import { getSupabaseAdmin } from './supabase';
import { jaucianRead } from './veo-jaucian';
import { telegramGroupCatalog } from './veo-telegram-groups';

export async function syncTelegramWorkforce() {
    const db = getSupabaseAdmin(), claim = await db.rpc('veo_claim_telegram_sync');
    if (claim.error) throw new Error('Telegram sync scheduling unavailable');
    if (!claim.data) return { due: false };
    const job = claim.data;
    let automatic: any = null, automaticPending = false;
    try {
        const live = await jaucianRead(job.tenant_id, { resource: 'automatic', offset: String(job.auto_cursor || 0), limit: '4' });
        const [pages, tenant] = await Promise.all([
            db.from('pages').select('id,name,fb_page_id').eq('veo_tenant_id', job.tenant_id).eq('veo_enabled', true),
            db.from('veo_tenants').select('owner_id').eq('id', job.tenant_id).single()
        ]);
        if (pages.error || tenant.error) throw Error('Automatic Telegram directory unavailable');
        const approved = new Set((process.env.VEO_APPROVED_TELEGRAM_CHAT_IDS || '').split(',').map(v => v.trim()).filter(Boolean));
        if (!approved.size) throw Error('Approved VEO groups are not configured');
        const groups = telegramGroupCatalog(live.groups, pages.data || [], approved);
        if (live.groups.length && !groups.length) throw Error('Approved Telegram directory did not match');
        const catalog = await db.rpc('veo_sync_telegram_groups', { p_actor: tenant.data.owner_id, p_groups: groups });
        if (catalog.error) throw Error('Automatic Telegram directory could not be saved');
        const applied = await db.rpc('veo_apply_telegram_automation', { p_tenant: job.tenant_id, p_payload: live });
        if (applied.error) throw Error('Automatic Telegram mappings could not be reconciled');
        automatic = applied.data;automaticPending = Number(live.next_offset) > 0;
    } catch {
        automaticPending = true;
        const saved = await db.from('veo_telegram_sync_state').update({ auto_last_error: 'Automatic Telegram setup unavailable; previous mappings and Page access retained' }).eq('tenant_id', job.tenant_id);
        if (saved.error) throw Error('Automatic Telegram setup checkpoint unavailable');
    }
    try {
        const observations = await jaucianRead(job.tenant_id, { resource: 'workforce', offset: String(job.cursor || 0), limit: '8' });
        const applied = await db.rpc('veo_apply_telegram_observations', { p_tenant: job.tenant_id, p_payload: observations });
        if (applied.error) throw new Error('Telegram observations could not be reconciled');
        if (automaticPending) {
            const saved = await db.from('veo_telegram_sync_state').update({ next_sync_at: new Date(Date.now() + 60000).toISOString() }).eq('tenant_id', job.tenant_id);
            if (saved.error) throw Error('Automatic Telegram setup scheduling unavailable');
        }
        return { due: true, ...applied.data, automatic };
    } catch {
        const saved = await db.from('veo_telegram_sync_state').update({ last_error: 'Telegram verification unavailable; no accounts removed from unknown membership', lease_until: null, next_sync_at: new Date(Date.now() + 120000).toISOString() }).eq('tenant_id', job.tenant_id);
        if (saved.error) throw new Error('Telegram sync failure checkpoint unavailable');
        return { due: true, retry: true };
    }
}
