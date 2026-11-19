import { getSupabaseAdmin } from './supabase';
import { readContactIdentityBatch } from './veo-contact-identity-sync';
import { requireStorageForOptionalWork } from './veo-storage-health';

/** Reconcile names/identities only. Real inbound webhooks establish inquiries;
 * an old conversation identity never establishes new activity or sends a bot. */
export async function syncAutomaticContactIdentities(db: any = getSupabaseAdmin()) {
    // Reserve twenty seconds for the two leased Pages' final checkpoints.
    const deadline = Date.now() + 40000;
    await requireStorageForOptionalWork(db);
    const claim = await db.rpc('veo_claim_contact_identity_pages', { p_limit: 2 });
    if (claim.error || !Array.isArray(claim.data)) throw Error('Automatic contact synchronization is unavailable');
    let inserted = 0, updated = 0, failed = 0;
    async function processPage(page: any) {
        let next: string | null = null, added = 0, names = 0, error: string | null = null;
        try {
            if (Date.now() + 28000 > deadline) throw Error('Background sync budget reached; retry');
            await requireStorageForOptionalWork(db);
            const signal = AbortSignal.timeout(18000);
            // Always check the head as well as the saved historical cursor, so
            // a large archive cannot hide a newly active client during catch-up.
            const batches = await Promise.all([readContactIdentityBatch(page, undefined, signal), ...(page.cursor ? [readContactIdentityBatch(page, page.cursor, signal)] : [])]);
            const candidate = batches.at(-1)!.next_cursor;
            const contacts = [...new Map(batches.flatMap(batch => batch.contacts).map(c => [c.psid, c])).values()];
            for (let offset = 0; offset < contacts.length; offset += 50) {
                if (Date.now() + 20000 > deadline) throw Error('Background sync budget reached; retry');
                await requireStorageForOptionalWork(db);
                const saved = await db.rpc('veo_seed_contact_identities', { p_actor: page.owner_id, p_page: page.page_id, p_contacts: contacts.slice(offset, offset + 50) });
                if (saved.error) throw Object.assign(Error('Could not save automatic contact identities'), { code: saved.error.code });
                added += Number(saved.data?.inserted || 0);names += Number(saved.data?.updated_names || 0);
            }
            next = candidate;
        } catch (failure: any) {
            error = ['STORAGE_ATTENTION', '55P03'].includes(failure?.code) || failure?.message === 'Background sync budget reached; retry'
                ? 'Automatic contact sync is paused; it will retry from saved progress.'
                : 'Automatic contact sync needs retry. Verify this Page connection if the error persists.';
        }
        finally {
            const finished = await db.rpc('veo_finish_contact_identity_page', { p_page: page.page_id, p_lease: page.lease_owner, p_cursor: next, p_inserted: added, p_updated: names, p_error: error });
            if (finished.error || finished.data !== true) throw Error('Automatic contact sync checkpoint unavailable');
            if (error) failed++;
            inserted += added;updated += names;
        }
    }
    // Keep Page writes serial and leave time to release every claimed lease.
    // The Page's recent head and historical cursor are both retained on retry.
    for (const page of claim.data) {
        try { await processPage(page); } catch { failed++; }
    }
    return { pages: claim.data.length, inserted, updated_names: updated, failed };
}
