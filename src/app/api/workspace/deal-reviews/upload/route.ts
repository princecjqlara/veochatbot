import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import { getSupabaseAdmin } from '@/lib/supabase';
import { uuid } from '@/lib/veo-workspace';
import { receiptPhoto } from '@/lib/veo-receipts';
import { dealChecked, dealEvidenceBucket, dealReviewScope, evidenceSlots } from '@/lib/veo-deal-review';
import { requireStorageForOptionalWork } from '@/lib/veo-storage-health';
export const dynamic = 'force-dynamic';
export const maxDuration = 45;
const reply = (body: any, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export async function POST(request: NextRequest) {
    try {
        if (request.headers.get('origin') !== request.nextUrl.origin) return reply({ error: 'Same-origin request required' }, 403);
        const scope = await dealReviewScope(request), form = await request.formData();
        const contact = form.get('contact_id'), seller = form.get('seller_id'), batch = form.get('request_id'), slot = form.get('slot'), kind = form.get('receipt_kind'), photo = form.get('photo');
        if (![contact, seller, batch].every(uuid) || !evidenceSlots.includes(slot as any) || !['closed', 'done'].includes(String(kind)) || !photo || typeof photo === 'string') throw Error('Select the contact and choose a stage, receipt or order photo');
        if (photo.size > 3 * 1024 * 1024) throw Error('Each evidence photo must be 3 MB or smaller');
        const db = getSupabaseAdmin();
        const context = dealChecked(await db.rpc('veo_deal_review_context', { p_actor: scope.user_id, p_contact: contact, p_seller: seller }));
        await requireStorageForOptionalWork(db);
        const bytes = new Uint8Array(await photo.arrayBuffer());receiptPhoto(photo, bytes);
        const path = `${scope.tenant_id}/${scope.user_id}/deal-evidence/${randomUUID()}`;
        dealChecked(await db.from('veo_photo_objects').insert({ object_path: path }));
        dealChecked(await db.storage.from(dealEvidenceBucket).upload(path, bytes, { contentType: photo.type, upsert: false }));
        const saved = dealChecked(await db.from('veo_deal_review_photos').insert({ request_id: batch, tenant_id: scope.tenant_id, page_id: context.page_id, contact_id: contact, seller_id: seller, uploaded_by: scope.user_id, receipt_kind: kind, slot, object_path: path, photo_sha256: createHash('sha256').update(bytes).digest('hex') }).select('id,slot').single());
        return reply({ photo: saved }, 201);
    } catch (e: any) { return reply({ error: e.message || 'Evidence upload failed' }, e.status || 400); }
}
