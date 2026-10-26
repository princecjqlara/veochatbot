import { createHash } from 'node:crypto';

type Db = { rpc: (name: string, args: Record<string, unknown>) => any };
const id = (x: unknown): string | null => typeof x === 'string' && /^\d{1,100}$/.test(x) ? x : null;
const text = (x: unknown, max = 500) => typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : null;
export function safeAdMediaUrl(x: unknown): string | null {
    if (typeof x !== 'string' || x.length > 4096) return null;
    try { const u = new URL(x); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; }
}

export function parseAdSourceEvent(event: any, pageFacebookId: string) {
    if (!event?.sender?.id || event.sender.id === pageFacebookId || event.message?.is_echo) return null;
    const ms = Number(event.timestamp);
    if (event.timestamp == null || !Number.isFinite(ms) || ms <= 0 || ms > Date.now() + 60_000) return null;
    const kind = event.message ? 'message' : event.postback ? 'postback' : event.referral ? 'referral' : null;
    if (!kind) return null;
    const isInquiry = kind === 'message'
        ? Boolean(text(event.message.text) || event.message.attachments?.length || event.message.quick_reply?.payload)
        : kind === 'postback' && Boolean(text(event.postback.payload) || text(event.postback.title));
    const raw = event.message?.referral || event.postback?.referral || event.referral;
    const referral: Record<string, unknown> = {};
    if (raw && typeof raw === 'object') {
        const adId = id(raw.ad_id);
        if (adId) referral.ad_id = adId;
        for (const k of ['source', 'type', 'ref']) { const value = text(raw[k], k === 'ref' ? 2000 : 100); if (value) referral[k] = value; }
        const context = raw.ads_context_data;
        if (context && typeof context === 'object') {
            const safe: Record<string, string> = {};
            const title = text(context.ad_title), postId = text(context.post_id, 100);
            if (title) safe.ad_title = title;
            if (postId && /^[\d_]+$/.test(postId)) safe.post_id = postId;
            for (const k of ['photo_url', 'video_url']) { const url = safeAdMediaUrl(context[k]); if (url) safe[k] = url; }
            referral.ads_context_data = safe;
        }
    }
    const messageId = kind === 'postback'
        ? 'postback:' + createHash('sha256').update(JSON.stringify([pageFacebookId, event.sender.id, ms, event.postback?.payload || event.postback?.title])).digest('hex')
        : text(event.message?.mid, 200);
    // Include the source data so a duplicate event carrying an enriched/conflicting
    // referral is retained as evidence; use message ID to reconcile the original.
    const fingerprint = JSON.stringify([pageFacebookId, event.sender.id, ms, kind, messageId, event.postback?.payload || null, referral]);
    return { eventKey: createHash('sha256').update(fingerprint).digest('hex'), eventAt: new Date(ms).toISOString(), kind, isInquiry, messageId, referral };
}

export async function captureContactAdSource(db: Db, input: {
    pageId: string; pageFacebookId: string; contactId: string; event: any;
    priorFirstAt?: string | null; knownConversation?: { messages?: { data?: Array<{ id: string; from?: { id: string }; created_time: string }> } } | null;
}) {
    const parsed = parseAdSourceEvent(input.event, input.pageFacebookId);
    if (!parsed) return;
    const priorTimes = [input.priorFirstAt, ...(input.knownConversation?.messages?.data || [])
        .filter(m => m.from?.id === input.event.sender.id && m.id !== parsed.messageId).map(m => m.created_time)]
        .filter((v): v is string => Boolean(v) && Number.isFinite(Date.parse(v!)) && Date.parse(v!) < Date.parse(parsed.eventAt));
    const prior = priorTimes.sort((a, b) => Date.parse(a) - Date.parse(b))[0] || null;
    const { error } = await db.rpc('record_contact_ad_event', {
        p_page_id: input.pageId, p_contact_id: input.contactId, p_event_key: parsed.eventKey,
        p_event_at: parsed.eventAt, p_event_kind: parsed.kind, p_is_inquiry: parsed.isInquiry,
        p_message_id: parsed.messageId, p_referral: parsed.referral, p_prior_first_at: prior
    });
    if (error) throw new Error('Could not preserve ad-source evidence');
}

export async function captureStandaloneAdReferral(db: Db, pageId: string, pageFacebookId: string, event: any) {
    const parsed = parseAdSourceEvent(event, pageFacebookId);
    if (!parsed || parsed.kind !== 'referral') return;
    const { error } = await db.rpc('record_standalone_ad_referral', { p_page_id: pageId, p_psid: event.sender.id,
        p_event_key: parsed.eventKey, p_event_at: parsed.eventAt, p_referral: parsed.referral });
    if (error) throw new Error('Could not preserve referral touch');
}
