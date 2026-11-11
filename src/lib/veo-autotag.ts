import { getSupabaseAdmin } from './supabase';
import { syncMessengerStageHistory } from './messenger-stage-sync';

type PageScan = { page_id: string; fb_page_id: string; access_token: string; launch_at: string; owner_id: string; lease_token: string; checked_at: string; cursor: string | null };
const failure = (code: string) => Object.assign(new Error('Auto-tag recovery is temporarily unavailable'), { scanCode: code });

/** Stage-only recovery on existing workspace contacts. No transcript import, bot
 * delivery, customer creation, payment inference or legacy worker invocation. */
export async function scanVeoAutoTags(page: PageScan, db = getSupabaseAdmin()) {
    const deadline = Date.now() + 70000, cutoff = Math.max(Date.parse(page.launch_at), Date.parse(page.checked_at));
    const counts = { conversations: 0, stage_events: 0, repaired_tags: 0 };
    let nextCursor: string | null = null;
    try {
        if (!/^\d{1,100}$/.test(page.fb_page_id) || !page.access_token || !Number.isFinite(cutoff)) throw failure('PAGE_CONNECTION_REQUIRED');
        const repair = await db.rpc('veo_repair_autotag_history', { p_page: page.page_id, p_limit: 250 });
        if (repair.error) throw failure('TAG_REPAIR_UNAVAILABLE'); counts.repaired_tags = Number(repair.data || 0);
        async function graph(path: string, params: Record<string, string>) {
            if (Date.now() >= deadline) throw failure('SCAN_DEADLINE');
            const url = new URL('https://graph.facebook.com/v21.0/' + path);
            for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
            let response: Response, body: any;
            try { response = await fetch(url, { headers: { Authorization: 'Bearer ' + page.access_token }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(8000, deadline - Date.now()))) }); body = await response.json(); }
            catch { throw failure('META_READ_UNAVAILABLE'); }
            if (!response.ok || body.error) throw failure([10, 190, 200].includes(body.error?.code) ? 'PAGE_RECONNECT_REQUIRED' : 'META_READ_UNAVAILABLE');
            if (!Array.isArray(body.data)) throw failure('META_RESPONSE_INCOMPLETE');
            return body;
        }
        const params = { fields: 'id,participants,updated_time', limit: '5', since: String(Math.floor(cutoff / 1000)) };
        const batch = await graph(page.fb_page_id + '/conversations', { ...params, ...(page.cursor ? { after: page.cursor } : {}) });
        if (batch.paging?.next) {
            const cursor = batch.paging.cursors?.after;
            if (typeof cursor !== 'string' || !cursor || cursor.length > 8192 || cursor === page.cursor) throw failure('META_CURSOR_INVALID');
            nextCursor = cursor;
        }
        // A long older scan must not starve the newest edits.
        const head = page.cursor ? await graph(page.fb_page_id + '/conversations', { ...params, limit: '2' }) : null;
        const conversations = [...new Map([...batch.data, ...(head?.data || [])].map((row: any) => [row.id, row])).values()] as any[];
        let unmatched = 0;
        for (const conversation of conversations) {
            const updated = Date.parse(conversation.updated_time || '');
            if (!Number.isFinite(updated)) throw failure('META_CONVERSATION_DATE_MISSING');
            if (updated < cutoff) continue;
            const participants = (conversation.participants?.data || []).filter((p: any) => p.id !== page.fb_page_id);
            if (participants.length !== 1 || typeof participants[0].id !== 'string') throw failure('META_CONTACT_AMBIGUOUS');
            const contact = await db.from('contacts').select('id').eq('page_id', page.page_id).eq('psid', participants[0].id).maybeSingle();
            if (contact.error) throw failure('CONTACT_LOOKUP_UNAVAILABLE');
            // Leave a retry visible until the normal Page identity/event sync
            // supplies this contact; never invent a client from stage text.
            if (!contact.data) { unmatched++; continue; }
            const history = await graph(encodeURIComponent(conversation.id) + '/messages', { fields: 'id,message,from,created_time', limit: '100' });
            if (history.data.some((m: any) => m.from?.id === page.fb_page_id && /^Lead stage set to /i.test(m.message?.trim() || '') && (!m.id || !Number.isFinite(Date.parse(m.created_time))))) throw failure('META_STAGE_EVIDENCE_INCOMPLETE');
            const messages = history.data.filter((m: any) => Date.parse(m.created_time) >= Date.parse(page.launch_at) && Date.parse(m.created_time) <= Date.now());
            const stages = await syncMessengerStageHistory(db, { pageId: page.page_id, contactId: contact.data.id, facebookPageId: page.fb_page_id, messages });
            counts.conversations++; counts.stage_events += stages.events;
            if (history.paging?.next && !history.data.some((m: any) => Date.parse(m.created_time) < Date.parse(page.launch_at))) {
                const queued = await db.rpc('veo_request_source_refresh', { p_actor: page.owner_id, p_contact: contact.data.id });
                if (queued.error) throw failure('DEEP_HISTORY_QUEUE_UNAVAILABLE');
            }
        }
        if (unmatched) throw failure('CONTACT_SYNC_REQUIRED');
        // Match the existing newest-first conversation read: dates older than
        // the checkpoint end this pass instead of walking the pre-launch archive.
        if (batch.data.some((row: any) => Date.parse(row.updated_time || '') < cutoff)) nextCursor = null;
        const finished = await db.rpc('veo_finish_autotag_page', { p_page: page.page_id, p_lease: page.lease_token, p_result: { ...counts, next_cursor: nextCursor } });
        if (finished.error || finished.data !== true) throw failure('SCAN_LEASE_LOST');
        return { complete: true, ...counts };
    } catch (error: any) {
        const finished = await db.rpc('veo_finish_autotag_page', { p_page: page.page_id, p_lease: page.lease_token, p_result: { ...counts, error: error.scanCode || 'TAG_STORAGE_UNAVAILABLE' } });
        if (finished.error) throw failure('SCAN_CHECKPOINT_UNAVAILABLE');
        return { complete: false, ...counts };
    }
}

export async function processVeoAutoTags(limit = 3) {
    const db = getSupabaseAdmin(), claim = await db.rpc('veo_claim_autotag_pages', { p_limit: limit });
    if (claim.error || !Array.isArray(claim.data)) throw failure('SCAN_CLAIM_UNAVAILABLE');
    const results = await Promise.allSettled(claim.data.map((page: PageScan) => scanVeoAutoTags(page, db)));
    const completed = results.filter(result => result.status === 'fulfilled' && result.value.complete).length;
    return { pages: results.length, completed, failed: results.length - completed };
}
