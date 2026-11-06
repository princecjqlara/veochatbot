import { createHash, createHmac } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from './supabase';
import { verifyWebhookSignature } from './facebook';
import { messengerTimestamp } from './messenger-timestamp';
import { veoEventReplay } from './veo-event-context';

export async function receiveWorkspaceEvents(request: Request) {
    const raw = await request.text(), secret = process.env.FACEBOOK_APP_SECRET;
    if (!secret || !verifyWebhookSignature(raw, request.headers.get('x-hub-signature-256') || '', secret)) return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    try {
        const payload = JSON.parse(raw);
        if (payload.object !== 'page' || !Array.isArray(payload.entry)) throw new Error('Invalid page event');
        const db = getSupabaseAdmin();
        for (const entry of payload.entry) {
            for (const key of ['messaging', 'standby', 'changes']) for (const event of entry[key] || []) {
                const at = messengerTimestamp(event.timestamp ?? entry.time);
                if (at == null) continue; // Unknown event dates cannot be represented as launch-period history.
                const envelope = { object: 'page', entry: [{ id: entry.id, time: entry.time, [key]: [event] }] };
                const id = `${entry.id}:${key}:${event.message?.mid || createHash('sha256').update(JSON.stringify(event)).digest('hex')}`;
                const saved = await db.rpc('veo_ingest_event', { p_fb_page: entry.id, p_key: id, p_at: new Date(at).toISOString(), p_payload: envelope });
                if (saved.error) throw new Error('Event persistence unavailable');
            }
        }
        return NextResponse.json({ received: true }, { status: 200 });
    } catch { return NextResponse.json({ error: 'Event persistence failed; retry required' }, { status: 503 }); }
}
export async function processWorkspaceEvents(handler: (request: NextRequest) => Promise<Response>, origin: string, processingBudgetMs = 210000) {
    const db = getSupabaseAdmin();
    const deadline = Date.now() + Math.max(0, Math.min(210000, processingBudgetMs));
    let processed = 0;
    // Drain successive small leases while there is time. A single 20-event
    // lease per minute fell behind real Page traffic. The DB leases only the
    // oldest outstanding event per conversation, including across cron runs.
    // Four separate conversations can progress together; each stays serial.
    while (processed < 200 && Date.now() < deadline) {
        const claimed = await db.rpc('veo_claim_events', { p_limit: Math.min(20, 200 - processed) });
        if (claimed.error) throw new Error('Event queue unavailable');
        if (!claimed.data?.length) break;
        const lanes = new Map<string, any[]>();
        for (const event of claimed.data) {
            const key = event.conversation_key || event.event_key;
            lanes.set(key, [...(lanes.get(key) || []), event]);
        }
        const jobs = [...lanes.values()];
        let cursor = 0;
        async function worker() {
            while (cursor < jobs.length) for (const event of jobs[cursor++]) {
                if (Date.now() >= deadline) {
                    const released = await db.from('veo_event_inbox').update({ status: 'queued', lease_until: null }).eq('event_key', event.event_key).eq('attempts', event.attempts);
                    if (released.error) throw new Error('Could not release an unprocessed event');
                    continue;
                }
                let failure: string | null = null;
                try {
                    const body = JSON.stringify(event.payload);
                    const signature = createHmac('sha256', process.env.FACEBOOK_APP_SECRET!).update(body).digest('hex');
                    const response = await veoEventReplay.run(true, () => handler(new NextRequest(new URL('/api/facebook/webhook', origin), { method: 'POST', body,
                        headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': `sha256=${signature}` } })));
                    if (!response.ok) failure = `Event processing returned ${response.status}`;
                } catch { failure = 'Event processing failed; scheduled retry'; }
                const updated = await db.from('veo_event_inbox').update({ status: failure ? 'queued' : 'done', last_error: failure, lease_until: null,
                    next_attempt_at: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(event.attempts, 7))).toISOString() }).eq('event_key', event.event_key).eq('attempts', event.attempts);
                if (updated.error) throw new Error('Could not save event processing state');
                processed++;
            }
        }
        const workers = await Promise.allSettled(Array.from({ length: Math.min(4, jobs.length) }, () => worker()));
        const failed = workers.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed) throw failed.reason;
    }
    return processed;
}
