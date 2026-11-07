import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { workspaceScope, philippineDate, uuid } from '@/lib/veo-workspace';
import { readVeoRpc } from '@/lib/veo-report-read';
import { receiptPhoto } from '@/lib/veo-receipts';
import { parseMoneyMinor } from '@/lib/contact-profile-evidence';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
const bucket = 'veo-conversation-submissions';
const response = (body: any, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (e: any) => response({ error: e.code === 'DATABASE_UNAVAILABLE' || e.code === '57014' ? 'Receipt report is busy. Retry shortly.' : e.message || 'Receipt service unavailable' }, e.status || (e.code === 'DATABASE_UNAVAILABLE' || e.code === '57014' ? 503 : 400));
async function access(r: NextRequest) {
    const session = await getSessionFromRequest(r);
    if (!session?.user?.id) throw Object.assign(Error('Sign in required'), { status: 401 });
    const scope = await workspaceScope(session.user.id);
    if (!scope?.launch_at) throw Object.assign(Error('Workspace access is inactive'), { status: 403 });
    return scope;
}
function checked(result: any) {
    if (result.error) throw Object.assign(Error(result.error.code === '57014' ? 'Receipt service is busy. Recheck before trying again.' : result.error.message || 'Receipt service unavailable'), { code: result.error.code, status: result.error.code === '42501' ? 403 : result.error.code === '23505' ? 409 : result.error.code === '57014' ? 503 : 400 });
    return result.data;
}
export async function GET(request: NextRequest) {
    try {
        const scope = await access(request), db = getSupabaseAdmin(), q = request.nextUrl.searchParams;
        if (q.get('commission') === '1') {
            const worker = q.get('worker_id') || scope.user_id, day = q.get('date') || philippineDate();
            if (!uuid(worker) || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) throw Error('Choose a worker and valid Philippine date');
            return response(checked(await readVeoRpc(db, 'veo_receipt_commission', { p_actor: scope.user_id, p_seller: worker, p_day: day })));
        }
        if (q.has('receipt_id')) {
            const id = q.get('receipt_id'); if (!uuid(id)) throw Error('Choose a receipt');
            const data = checked(await readVeoRpc(db, 'veo_receipt_access', { p_actor: scope.user_id, p_id: id }));
            if (q.get('preview') === '1' && data.photo_available) {
                const row = await db.from('veo_receipts').select('object_path').eq('id', id).single();
                if (row.error) throw Error('Photo unavailable');
                const signed = await db.storage.from(bucket).createSignedUrl(row.data.object_path, 60);
                if (signed.error) throw Error('Photo unavailable; re-upload may be required');
                data.photo_url = signed.data.signedUrl;
            }
            return response(data);
        }
        const from = q.get('from') || philippineDate(), to = q.get('to') || philippineDate(), offset = Number(q.get('offset') || 0), worker = q.get('worker_id') || null, page = q.get('page_id') || null;
        const valid = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
        if (!valid(from) || !valid(to) || !Number.isSafeInteger(offset) || offset < 0 || worker && !uuid(worker) || page && !uuid(page)) throw Error('Choose valid receipt filters');
        return response(checked(await readVeoRpc(db, 'veo_receipts_page', { p_actor: scope.user_id, p_from: from, p_to: to, p_seller: worker, p_page: page, p_offset: offset })));
    } catch (e) { return fail(e); }
}
export async function POST(request: NextRequest) {
    let uploaded: string | null = null, requestId: string | null = null, actor: string | null = null;
    const db = getSupabaseAdmin();
    async function removeUpload() {
        if (!uploaded) return;
        const deleted = await db.storage.from(bucket).remove([uploaded]);
        if (!deleted.error) await db.from('veo_photo_objects').update({ deleted_at: new Date().toISOString() }).eq('object_path', uploaded);
    }
    try {
        if (request.headers.get('origin') !== request.nextUrl.origin) throw Object.assign(Error('Same-origin request required'), { status: 403 });
        const scope = await access(request); actor = scope.user_id;
        if (!request.headers.get('content-type')?.includes('multipart/form-data')) {
            const body = await request.json();
            if (body.action === 'notes') {
                if (!uuid(body.receipt_id) || typeof body.notes !== 'string' || body.notes.length > 2000) throw Error('Choose a receipt and notes of at most 2000 characters');
                return response(checked(await db.rpc('veo_receipt_note', { p_actor: scope.user_id, p_id: body.receipt_id, p_notes: body.notes })));
            }
            if (body.action !== 'recheck' || !uuid(body.receipt_id) || body.order_id && !uuid(body.order_id)) throw Error('Choose a receipt and valid order');
            return response(checked(await db.rpc('veo_receipt_recheck', { p_actor: scope.user_id, p_id: body.receipt_id, p_order: body.order_id || null })));
        }
        const form = await request.formData(), file = form.get('photo'), contact = form.get('contact_id'), seller = form.get('seller_id') || scope.user_id, order = form.get('order_id') || null, notes = form.get('notes') || '';
        requestId = String(form.get('request_id') || '');
        if (!uuid(contact) || !uuid(seller) || !uuid(requestId) || order && !uuid(order) || !file || typeof file === 'string' || !['closed', 'done'].includes(String(form.get('receipt_kind')))) throw Error('Choose a client, seller, receipt type and photo');
        if (typeof notes !== 'string' || notes.length > 2000) throw Error('Notes must be at most 2000 characters');
        const kind = String(form.get('receipt_kind')), closedId = form.get('closed_deal_id') || null;
        const dealMode = String(form.get('deal_mode') || '');if (!['new','existing'].includes(dealMode) || dealMode === 'new' && closedId) throw Error('Choose New deal or Complete existing Closed Deal');
        if (closedId && !uuid(closedId)) throw Error('Choose a Closed Deal for this client');
        const closedAmount = kind === 'closed' ? parseMoneyMinor(form.get('closed_amount')) : null;
        const closedCurrency = kind === 'closed' ? String(form.get('closed_currency') || 'PHP').toUpperCase() : null;
        const closedAt = kind === 'closed' ? String(form.get('closed_occurred_at') || '') : null;
        if (kind === 'closed' && (!/^[A-Z]{3}$/.test(closedCurrency!) || !closedAt || !Number.isFinite(Date.parse(closedAt)))) throw Error('Enter the Closed Deal amount, currency and Philippine payment time');
        if (file.size > 3 * 1024 * 1024) throw Error('Choose a receipt up to 3 MB');
        const bytes = new Uint8Array(await file.arrayBuffer()); receiptPhoto(file, bytes);
        // Recheck Page and seller grants before storing a private object.
        const contactAccess = checked(await db.rpc('veo_profile_detail_access', { p_actor: scope.user_id, p_contact: contact }));
        if (!scope.worker_ids.includes(String(seller)) || !contactAccess) throw Object.assign(Error('Seller outside your branch'), { status: 403 });
        const path = `${scope.tenant_id}/${scope.user_id}/${randomUUID()}`;
        checked(await db.from('veo_photo_objects').insert({ object_path: path })); uploaded = path;
        const stored = await db.storage.from(bucket).upload(path, bytes, { contentType: file.type, upsert: false }); checked(stored);
        const saved = checked(await db.rpc('veo_receipt_save', { p_actor: scope.user_id, p_data: { request_id: requestId, contact_id: contact, seller_id: seller, order_id: order, receipt_kind: kind, deal_mode: dealMode, closed_deal_id: closedId, closed_amount_minor: closedAmount, closed_currency: closedCurrency, closed_occurred_at: closedAt, notes, object_path: path, photo_sha256: createHash('sha256').update(bytes).digest('hex') } }));
        if (saved.duplicate) await removeUpload();
        return response({ saved }, saved.duplicate ? 200 : 202);
    } catch (e) {
        if (uploaded && requestId && actor) {
            // A lost response can follow a committed save. Retain its photo and
            // recover by the stable request ID; never delete an uncertain save.
            const existing = await db.from('veo_receipts').select('id').eq('request_id', requestId).eq('submitted_by', actor).maybeSingle();
            if (!existing.error && existing.data) {
                const recovered = await db.rpc('veo_receipt_access', { p_actor: actor, p_id: existing.data.id });
                if (!recovered.error) return response({ saved: recovered.data });
            }
            if (!existing.error && !existing.data) await removeUpload();
        }
        return fail(e);
    }
}
