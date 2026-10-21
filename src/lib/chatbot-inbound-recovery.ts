import { createHmac } from 'crypto';
import { NextRequest } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

type Db = { from: (table: string) => any; rpc: (name: string, args: Record<string, unknown>) => any };
type RecoveryPage = { page_id: string; enabled_at: string; scan_cursor: string | null; lease_until: string };
type Message = { id?: string; message?: string; created_time?: string; from?: { id?: string };
    attachments?: { data?: Array<{ mime_type?: string; image_data?: { url?: string } }> } };
type Thread = { id: string; messages?: { data?: Message[] }; updated_time?: string };
// An outage can outlast a short polling window. Recover unanswered inquiries
// throughout Meta's normal response window, bounded by explicit enrollment.
const INBOUND_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

async function graph(path: string, token: string) {
    const response = await fetch(`https://graph.facebook.com/v24.0/${path}`, {
        headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(5000)
    });
    const body = await response.json();
    if (!response.ok || body.error) throw new Error(body.error?.message || `Messenger recovery read HTTP ${response.status}`);
    return body;
}

async function dispatchRecoveredMessage(payload: unknown): Promise<Response> {
    const secret = process.env.FACEBOOK_APP_SECRET;
    if (!secret) throw new Error('Recovery dispatcher app secret is unavailable');
    const { POST } = await import('@/app/api/facebook/webhook/route');
    const body = JSON.stringify(payload);
    return POST(new NextRequest('https://internal.invalid/api/facebook/webhook', { method: 'POST', body,
        headers: { 'Content-Type': 'application/json',
            'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') } }));
}

/** Poll only explicitly enabled Pages. Reuse real IDs/times and the ordinary
 * handoff, consent, generation, dedupe, and per-bubble delivery guards. */
export async function recoverMissingChatbotMessages(input: {
    supabase?: Db; now?: Date; dispatch?: (payload: unknown) => Promise<Response>;
} = {}) {
    const db = input.supabase || getSupabaseAdmin();
    const now = input.now || new Date();
    const result = { pages: 0, scanned: 0, recovered: 0, failed: 0 };
    const { data: claims, error } = await db.rpc('claim_chatbot_inbound_recovery_pages', { p_limit: 3, p_now: now.toISOString() });
    if (error) throw new Error(error.message);
    // Bounded parallel claims keep all enabled Pages in rotation without one
    // slow Page consuming the entire minute worker's recovery slot.
    const pages = await Promise.allSettled(((claims || []) as RecoveryPage[]).map(async claim => {
        result.pages++;
        let nextCursor: string | null = claim.scan_cursor;
        let pageError: string | null = null;
        try {
            const { data: page, error: lookupError } = await db.from('pages').select('id,fb_page_id,access_token')
                .eq('id', claim.page_id).single();
            if (lookupError || !page?.access_token) throw new Error(lookupError?.message || 'Recovery Page is unavailable');
            const fields = 'id,updated_time,messages.limit(10){id,message,from,created_time,attachments{mime_type,image_data}}';
            const readThreads = (extra = '') => graph(`${page.fb_page_id}/conversations?fields=${encodeURIComponent(fields)}&limit=50${extra}`, page.access_token);
            // Always inspect the live head; an older campaign cursor must not hide fresh inquiries.
            const head = await readThreads();
            let threads: Thread[] = head.data || [];
            const deep = claim.scan_cursor ? await readThreads(`&after=${encodeURIComponent(claim.scan_cursor)}`) : head;
            if (claim.scan_cursor) threads = [...threads, ...(deep.data || [])];
            nextCursor = deep.paging?.next ? deep.paging?.cursors?.after || null : null;
            const cutoff = Math.max(Date.parse(claim.enabled_at), now.getTime() - INBOUND_RECOVERY_WINDOW_MS);
            if ((deep.data || []).some((thread: Thread) => Date.parse(thread.updated_time || '') < cutoff)) nextCursor = null;
            // A known active contact can be buried under a large campaign. Poll a
            // small recent-contact set independently of the conversation cursor.
            const hot = await db.from('chatbot_contact_states').select('contact_id').eq('page_id', claim.page_id)
                .eq('status', 'active').gte('window_expires_at', now.toISOString())
                .order('last_inbound_at', { ascending: false, nullsFirst: false }).limit(3);
            if (hot.error) throw new Error(hot.error.message);
            if (hot.data?.length) {
                const contacts = await db.from('contacts').select('psid').eq('page_id', claim.page_id).in('id', hot.data.map((state: any) => state.contact_id));
                if (contacts.error) throw new Error(contacts.error.message);
                const reads = await Promise.allSettled((contacts.data || []).filter((c: any) => c.psid)
                    .map((c: any) => readThreads(`&user_id=${encodeURIComponent(c.psid)}`)));
                for (const read of reads) if (read.status === 'fulfilled') threads.push(...(read.value.data || []));
            }
            const seen = new Set<string>();
            const candidates: Array<{ message: Message; images: Array<{ type: string; payload: { url: string } }> }> = [];
            for (const thread of threads) {
                if (seen.has(thread.id)) continue;
                seen.add(thread.id); result.scanned++;
                const message = [...(thread.messages?.data || [])].sort((a, b) => Date.parse(b.created_time || '') - Date.parse(a.created_time || ''))[0];
                const at = Date.parse(message?.created_time || '');
                if (!message?.id || !message.from?.id || message.from.id === page.fb_page_id ||
                    !Number.isFinite(at) || at < cutoff || at > now.getTime() - 5000) continue;
                const images = (message.attachments?.data || []).filter(a => a.mime_type?.startsWith('image/') && a.image_data?.url)
                    .slice(0, 3).map(a => ({ type: 'image', payload: { url: a.image_data!.url! } }));
                if (!message.message?.trim() && !images.length) continue;
                candidates.push({ message, images });
            }
            // One recovery per claimed Page keeps follow-up work responsive.
            for (const { message, images } of candidates.sort((a, b) => Date.parse(b.message.created_time!) - Date.parse(a.message.created_time!))) {
                const reply = await db.from('chatbot_reply_events').select('status,outbound_message_id,inbound_at').eq('page_id', claim.page_id).eq('inbound_message_id', message.id).maybeSingle();
                if (reply.error) throw new Error(reply.error.message);
                if (reply.data?.status === 'sent' || reply.data?.status === 'processing' || reply.data?.outbound_message_id) continue;
                // Messenger history rounds created_time to whole seconds. Use
                // the signed webhook's precise timestamp for this exact ID,
                // otherwise our newer-inbound guard rejects a valid retry.
                const historyAt = Date.parse(message.created_time!);
                const originalAt = Date.parse(reply.data?.inbound_at || '');
                const replayAt = Number.isFinite(originalAt) && Math.floor(originalAt / 1000) === Math.floor(historyAt / 1000)
                    ? originalAt : historyAt;
                if (replayAt < cutoff || replayAt > now.getTime() - 5000) continue;
                const saved = await db.from('chatbot_inbound_recovery_events').select('status,attempt_count,updated_at')
                    .eq('page_id', claim.page_id).eq('message_id', message.id).maybeSingle();
                if (saved.error) throw new Error(saved.error.message);
                if (saved.data?.status === 'done' || saved.data?.attempt_count >= 3 ||
                    (saved.data?.status === 'processing' && Date.parse(saved.data.updated_at) > now.getTime() - 3 * 60000)) continue;
                const payload = { page_id: claim.page_id, message_id: message.id, inbound_at: new Date(replayAt).toISOString(),
                    status: 'processing', attempt_count: (saved.data?.attempt_count || 0) + 1, error_message: null, updated_at: now.toISOString() };
                const acquired = await db.from('chatbot_inbound_recovery_events').upsert(payload, { onConflict: 'page_id,message_id' });
                if (acquired.error) throw new Error(acquired.error.message);
                try {
                    const response = await (input.dispatch || dispatchRecoveredMessage)({ object: 'page', entry: [{ id: page.fb_page_id,
                        messaging: [{ sender: { id: message.from!.id }, recipient: { id: page.fb_page_id }, timestamp: replayAt,
                            message: { mid: message.id, ...(message.message ? { text: message.message } : {}), ...(images.length ? { attachments: images } : {}) } }] }] });
                    if (!response.ok) throw new Error(`Recovered message handler HTTP ${response.status}`);
                    // The webhook acknowledges Meta even when a retryable
                    // generation/database failure prevented any reply. HTTP 200
                    // alone must not turn that failure into a completed recovery.
                    const delivery = await db.from('chatbot_reply_events').select('status,outbound_message_id,error_message')
                        .eq('page_id', claim.page_id).eq('inbound_message_id', message.id).maybeSingle();
                    if (delivery.error) throw new Error(delivery.error.message);
                    if (delivery.data?.status === 'failed' && !delivery.data.outbound_message_id) {
                        throw new Error(delivery.data.error_message || 'Recovered message did not deliver a reply');
                    }
                    const finished = await db.from('chatbot_inbound_recovery_events').update({ status: 'done', updated_at: new Date().toISOString() })
                        .eq('page_id', claim.page_id).eq('message_id', message.id).eq('status', 'processing');
                    if (finished.error) throw new Error(finished.error.message);
                    result.recovered++;
                } catch (dispatchError) {
                    const messageText = dispatchError instanceof Error ? dispatchError.message : String(dispatchError);
                    const recorded = await db.from('chatbot_inbound_recovery_events').update({ status: 'failed', error_message: messageText.slice(0, 500), updated_at: new Date().toISOString() })
                        .eq('page_id', claim.page_id).eq('message_id', message.id);
                    if (recorded.error) throw new Error(recorded.error.message);
                    pageError = messageText; result.failed++;
                }
                break;
            }
        } catch (readError) {
            pageError = readError instanceof Error ? readError.message : String(readError); result.failed++;
        } finally {
            const released = await db.from('chatbot_inbound_recovery_pages').update({ scan_cursor: nextCursor, lease_until: null, last_error: pageError })
                .eq('page_id', claim.page_id).eq('lease_until', claim.lease_until);
            if (released.error) throw new Error(released.error.message);
        }
    }));
    const failedRelease = pages.find((page): page is PromiseRejectedResult => page.status === 'rejected');
    if (failedRelease) throw failedRelease.reason;
    return result;
}
