import { readVeoRpc } from './veo-report-read';
export type ReviewedDeliveryState = 'awaiting_review' | 'waiting_for_setup' | 'queued' | 'delivered' | 'retry_scheduled' | 'needs_attention';
/** Queue only authorized, persisted receipts. The normal bot scheduler sends
 * the album; the existing workspace worker remains the durable retry path. */
export async function queueReviewedDelivery(db: any, review: any): Promise<{ state: ReviewedDeliveryState }> {
    if (review?.status !== 'approved') return { state: 'awaiting_review' };
    if (!review.delivery_submission) return { state: 'waiting_for_setup' };
    try {
        const target = new URL('/api/veo/handoff', process.env.VEO_JAUCIAN_URL);
        const secret = process.env.VEO_JAUCIAN_SECRET;
        if (target.protocol !== 'https:' || target.username || target.password || !secret) return { state: 'retry_scheduled' };
        const handoff = await readVeoRpc(db, 'veo_handoff', { p_submission: review.delivery_submission }, 6000);
        if (handoff.error || !handoff.data) return { state: 'retry_scheduled' };
        const response = await fetch(target, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(handoff.data), signal: AbortSignal.timeout(15000) });
        const body = await response.json();
        if (!response.ok || body.ok !== true) return { state: 'retry_scheduled' };
        if (body.status === 'cancelled') return { state: 'needs_attention' };
        return { state: body.status === 'sent' ? 'delivered' : 'queued' };
    } catch { return { state: 'retry_scheduled' }; }
}
