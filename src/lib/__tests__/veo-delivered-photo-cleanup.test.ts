import { createClient } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';
import { cleanupDeliveredReceiptPhotos } from '../veo-delivered-photo-cleanup';

const photo = (slot: string) => ({ object_path: 'tenant/member/deal-evidence/' + slot, object: { deleted_at: null },
    review: { status: 'approved', delivery_submission: 'submission', delivery: { id: 'submission', status: 'delivered', delivered_at: '2026-11-18T00:00:00Z' } } });
function database(rows = ['stage', 'payment', 'order'].map(photo), failure = '') {
    const requests: Array<{ url: URL; method: string; body: any }> = [];
    const fetcher = vi.fn(async (input: any, init: any = {}) => {
        const request = { url: new URL(String(input)), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null };requests.push(request);
        if (request.method === 'GET') return new Response(JSON.stringify(rows), { status: failure === 'scan' ? 503 : 200 });
        if (request.method === 'DELETE') return new Response(JSON.stringify(failure === 'storage' ? { message: 'Unavailable' } : []), { status: failure === 'storage' ? 503 : 200 });
        return failure === 'checkpoint' ? new Response(JSON.stringify({ message: 'Unavailable' }), { status: 503 }) : new Response(null, { status: 204 });
    });
    const db = createClient('https://fixture.supabase.co', 'test-service-key', { global: { fetch: fetcher }, auth: { persistSession: false, autoRefreshToken: false } });
    return { db, requests };
}
it('uses real SDK requests to remove all three delivered evidence files before checkpointing only photo metadata', async () => {
    const { db, requests } = database();
    expect(await cleanupDeliveredReceiptPhotos(db)).toEqual({ removed: 3 });
    const [scan, removal, checkpoint] = requests;
    expect(scan.url.searchParams.get('select')).toContain('veo_deal_reviews_delivery_submission_fkey!inner');
    expect(scan.url.searchParams.get('object.deleted_at')).toBe('is.null');
    expect(scan.url.searchParams.get('review.status')).toBe('eq.approved');
    expect(scan.url.searchParams.get('review.delivery.status')).toBe('eq.delivered');
    expect(scan.url.searchParams.get('review.delivery.delivered_at')).toBe('not.is.null');
    expect(scan.url.searchParams.get('limit')).toBe('90');
    expect(removal.method).toBe('DELETE');expect(removal.url.pathname).toBe('/storage/v1/object/veo-conversation-submissions');
    expect(removal.body.prefixes).toEqual(['stage', 'payment', 'order'].map(s => photo(s).object_path));
    expect(checkpoint.method).toBe('PATCH');expect(checkpoint.url.pathname).toBe('/rest/v1/veo_photo_objects');
    expect(Object.keys(checkpoint.body)).toEqual(['deleted_at']);
});
it('finds stranded stage/order photos even when the payment photo was already cleaned', async () => {
    const { db, requests } = database(['stage', 'order'].map(photo));
    expect(await cleanupDeliveredReceiptPhotos(db, 'submission')).toEqual({ removed: 2 });
    expect(requests[0].url.searchParams.get('review.delivery_submission')).toBe('eq.submission');
    expect(requests[0].url.searchParams.has('review.delivery.deleted_at')).toBe(false);
});
it('leaves failed storage deletions unacknowledged and permits retry after a failed metadata checkpoint', async () => {
    const failed = database(undefined, 'storage');
    await expect(cleanupDeliveredReceiptPhotos(failed.db)).rejects.toThrow('photo deletion pending');
    expect(failed.requests.map(r => r.method)).toEqual(['GET', 'DELETE']);
    const checkpoint = database(undefined, 'checkpoint');
    await expect(cleanupDeliveredReceiptPhotos(checkpoint.db)).rejects.toThrow('checkpoint pending');
    const retry = database();expect(await cleanupDeliveredReceiptPhotos(retry.db)).toEqual({ removed: 3 });
});
it.each(['pending', 'queued', 'missing_ack', 'different_submission'])('protects evidence without confirmed matching delivery: %s', async state => {
    const row = photo('payment');
    if (state === 'pending') row.review.status = 'pending';
    if (state === 'queued') row.review.delivery.status = 'queued';
    if (state === 'missing_ack') row.review.delivery.delivered_at = '';
    if (state === 'different_submission') row.review.delivery_submission = 'other';
    const { db, requests } = database([row]);
    await expect(cleanupDeliveredReceiptPhotos(db)).rejects.toThrow('eligibility could not be confirmed');
    expect(requests).toHaveLength(1);
});
it('does no storage work for an empty batch or an unavailable eligibility scan', async () => {
    const empty = database([]);expect(await cleanupDeliveredReceiptPhotos(empty.db)).toEqual({ removed: 0 });expect(empty.requests).toHaveLength(1);
    const failed = database([], 'scan');await expect(cleanupDeliveredReceiptPhotos(failed.db)).rejects.toThrow('scan unavailable');expect(failed.requests).toHaveLength(1);
});
