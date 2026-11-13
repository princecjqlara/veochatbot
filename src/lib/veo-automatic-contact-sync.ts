import { getSupabaseAdmin } from './supabase';
import { readContactIdentityBatch } from './veo-contact-identity-sync';

/** Reconcile names/identities only. Real inbound webhooks establish inquiries;
 * an old conversation identity never establishes new activity or sends a bot. */
export async function syncAutomaticContactIdentities(db: any = getSupabaseAdmin()) {
    const claim = await db.rpc('veo_claim_contact_identity_pages', { p_limit: 3 });
    if (claim.error || !Array.isArray(claim.data)) throw Error('Automatic contact synchronization is unavailable');
    let inserted = 0, updated = 0, failed = 0;
    const results = await Promise.allSettled(claim.data.map(async (page: any) => {
        let next: string | null = null, added = 0, names = 0, error: string | null = null;
        try {
            const signal = AbortSignal.timeout(18000);
            // Always check the head as well as the saved historical cursor, so
            // a large archive cannot hide a newly active client during catch-up.
            const batches = await Promise.all([readContactIdentityBatch(page, undefined, signal), ...(page.cursor ? [readContactIdentityBatch(page, page.cursor, signal)] : [])]);
            next = batches.at(-1)!.next_cursor;
            const contacts = [...new Map(batches.flatMap(batch => batch.contacts).map(c => [c.psid, c])).values()];
            for (let offset = 0; offset < contacts.length; offset += 50) {
                const saved = await db.rpc('veo_seed_contact_identities', { p_actor: page.owner_id, p_page: page.page_id, p_contacts: contacts.slice(offset, offset + 50) });
                if (saved.error) throw Error('Could not save automatic contact identities');
                added += Number(saved.data?.inserted || 0);names += Number(saved.data?.updated_names || 0);
            }
        } catch { error = 'Automatic contact sync needs retry. Verify this Page connection if the error persists.'; }
        finally {
            const finished = await db.rpc('veo_finish_contact_identity_page', { p_page: page.page_id, p_lease: page.lease_owner, p_cursor: next, p_inserted: added, p_updated: names, p_error: error });
            if (finished.error || finished.data !== true) throw Error('Automatic contact sync checkpoint unavailable');
            if (error) failed++;
            inserted += added;updated += names;
        }
    }));
    failed += results.filter(r => r.status === 'rejected').length;
    return { pages: claim.data.length, inserted, updated_names: updated, failed };
}
