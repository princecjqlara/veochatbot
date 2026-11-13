import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { readVeoRpc } from '@/lib/veo-report-read';
import { uuid } from '@/lib/veo-workspace';
import { dealChecked, dealEvidenceBucket, dealReviewScope, dealSubmission } from '@/lib/veo-deal-review';
import { queueReviewedDelivery } from '@/lib/veo-reviewed-delivery';
import { queueReceiptDeletions } from '@/lib/veo-receipt-deletion';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;
const reply = (body: any, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export async function GET(request: NextRequest) {
    try {
        const scope = await dealReviewScope(request), db = getSupabaseAdmin(), q = request.nextUrl.searchParams;
        const id = q.get('review_id'), contact = q.get('contact_id'), offset = Number(q.get('offset') || 0), status = q.get('status') || 'all';
        if (id) {
            if (!uuid(id)) throw Error('Choose a review');
            const review = dealChecked(await readVeoRpc(db, 'veo_deal_review_access', { p_actor: scope.user_id, p_id: id }));
            const photos = dealChecked(await db.from('veo_deal_review_photos').select('id,slot,object_path').eq('review_id', id));
            review.photos = await Promise.all(photos.map(async (photo: any) => {
                const available = review.photos.find((f: any) => f.id === photo.id)?.available;
                if (!available) return { id: photo.id, slot: photo.slot, available: false };
                const signed = dealChecked(await db.storage.from(dealEvidenceBucket).createSignedUrl(photo.object_path, 300));
                return { id: photo.id, slot: photo.slot, available: true, photo_url: signed.signedUrl };
            }));
            return reply({ review });
        }
        if (contact && !uuid(contact) || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000 || !['all', 'pending', 'approved', 'rejected'].includes(status)) throw Error('Choose valid review filters');
        return reply(dealChecked(await readVeoRpc(db, 'veo_deal_reviews_page', { p_actor: scope.user_id, p_status: status, p_contact: contact || null, p_offset: offset, p_limit: 30 })));
    } catch (e: any) { return reply({ error: e.message || 'Reviews unavailable' }, e.status || 400); }
}
export async function POST(request: NextRequest) {
    try {
        if (request.headers.get('origin') !== request.nextUrl.origin) return reply({ error: 'Same-origin request required' }, 403);
        const scope = await dealReviewScope(request), body = await request.json(), db = getSupabaseAdmin();
        if (body.action === 'delete') {
            if (!['manager', 'team_leader'].includes(scope.role)) return reply({ error: 'Only Managers and Team Leaders can delete receipts. Ask your Manager or Team Leader.' }, 403);
            if (!uuid(body.review_id) || typeof body.reason !== 'string' || body.reason.trim().length < 3 || body.reason.length > 500) throw Error('Choose a receipt and enter a deletion reason of 3 to 500 characters');
            const review = dealChecked(await db.rpc('veo_deal_review_delete', { p_actor: scope.user_id, p_id: body.review_id, p_reason: body.reason.trim() }));
            return reply({ review, deletion_dispatch: review.delivery_submission ? await queueReceiptDeletions(db, review.delivery_submission) : { queued: 0, retry: false } });
        }
        if (body.action === 'submit') {
            const data = dealSubmission(body);
            const review = dealChecked(await db.rpc('veo_submit_deal_review', { p_actor: scope.user_id, p_data: data, p_photos: body.photo_ids }));
            return reply({ review, delivery_dispatch: await queueReviewedDelivery(db, review) }, 202);
        }
        if (body.action !== 'review' || !uuid(body.review_id) || !['approve', 'reject'].includes(body.decision) || typeof body.note !== 'string' || body.note.length > 2000) throw Error('Choose an approve/reject decision and a valid review note');
        if (!['owner', 'team_leader', 'manager'].includes(scope.role)) return reply({ error: 'Supervisor review access required' }, 403);
        const review = dealChecked(await db.rpc('veo_review_deal', { p_actor: scope.user_id, p_review: body.review_id, p_decision: body.decision, p_confirm_stage: body.confirm_stage === true, p_confirm_receipt: body.confirm_receipt === true, p_confirm_order: body.confirm_order === true, p_note: body.note }));
        return reply({ review, delivery_dispatch: await queueReviewedDelivery(db, review) });
    } catch (e: any) { return reply({ error: e.message || 'Review could not be saved' }, e.status || 400); }
}
