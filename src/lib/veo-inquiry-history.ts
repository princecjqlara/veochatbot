import { getSupabaseAdmin } from './supabase';

export function inquiryHistoryCursor(value: string | null | undefined) {
    if (!value) return null;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'graph.facebook.com' || url.username || url.password || !/\/messages(?:\/|$)/.test(url.pathname)) throw Error('Invalid inquiry history cursor');
    url.searchParams.delete('access_token');
    if (url.href.length > 4000) throw Error('Inquiry history cursor is too long');
    return url.href;
}

export function earliestCustomerMessage(raw: any[], psid: string, previous?: { at: string | null; id: string | null }) {
    let first = previous?.at && previous.id ? { at: previous.at, id: previous.id } : null;
    for (const message of raw) {
        if (message.from?.id !== psid) continue;
        const at = Date.parse(message.created_time);
        if (typeof message.id !== 'string' || !message.id || !Number.isFinite(at) || at > Date.now() + 60000) throw Error('Invalid customer inquiry metadata');
        if (!first || at < Date.parse(first.at)) first = { at: new Date(at).toISOString(), id: message.id };
    }
    return first;
}

async function graph(url: URL, token: string) {
    url.searchParams.delete('access_token');
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(9000) });
    const b = await r.json();
    if (!r.ok || b.error || !Array.isArray(b.data)) throw Error('Messenger history access unavailable; verify the Page connection');
    return b;
}

/** Metadata only: no customer text, model calls, or outbound messages. */
export async function recoverFirstInquiries(db: any = getSupabaseAdmin(), limit = 5) {
    const claims = await db.rpc('veo_claim_inquiry_history', { p_limit: limit });
    if (claims.error || !Array.isArray(claims.data)) throw Error('Inquiry history queue unavailable');
    let checked = 0, changed = 0, pending = 0, failed = 0;
    // Bound concurrency so historical reads do not crowd live webhooks.
    const jobs = claims.data.slice();
    async function worker() {
        while (jobs.length) {
            const job = jobs.shift();
            let cursor = job.cursor, first = job.first_at && job.first_message_id ? { at: job.first_at, id: job.first_message_id } : null, complete = false, error: string | null = null;
            const deadline = Date.now() + 45000;
            try {
                let batch: any;
                if (job.scan_started) {
                    if (!cursor) throw Error('History checkpoint is incomplete; retry required');
                    batch = await graph(new URL(inquiryHistoryCursor(cursor)!), job.access_token);
                } else {
                    const url = new URL(`https://graph.facebook.com/v24.0/${job.fb_page_id}/conversations`);
                    url.searchParams.set('user_id', job.psid); url.searchParams.set('limit', '1');
                    url.searchParams.set('fields', 'id,messages.limit(100){id,from,created_time}');
                    const response = await graph(url, job.access_token);
                    batch = response.data[0]?.messages;
                    if (!Array.isArray(batch?.data)) throw Error('No accessible conversation for this client');
                }
                const seen = new Set<string>();
                for (let page = 0; ; page++) {
                    first = earliestCustomerMessage(batch.data, job.psid, first || undefined);
                    cursor = inquiryHistoryCursor(batch.paging?.next);
                    if (!cursor) { complete = true; break; }
                    if (seen.has(cursor)) throw Error('Messenger returned a repeated history cursor');
                    seen.add(cursor);
                    if (page >= 5 || Date.now() >= deadline - 10000) break;
                    batch = await graph(new URL(cursor), job.access_token);
                }
            } catch (e: any) { error = e.message || 'Inquiry history recovery will retry'; }
            const saved = await db.rpc('veo_finish_inquiry_history', { p_contact: job.contact_id, p_lease: job.lease_token, p_cursor: complete ? null : cursor,
                p_first: first?.at || null, p_message: first?.id || null, p_complete: complete, p_error: error });
            if (saved.error || saved.data?.saved !== true || saved.data?.error) failed++;
            else if (saved.data.complete) { checked++; if (saved.data.changed) changed++; }
            else pending++;
        }
    }
    await Promise.all([worker(), worker()]);
    return { claimed: claims.data.length, checked, changed, pending, failed };
}
