import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { authorizeContactProfile } from '@/lib/contact-profile-access';
import { parseMoneyMinor } from '@/lib/contact-profile-evidence';
export const dynamic = 'force-dynamic';
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const date = (value: unknown) => { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Enter a valid transaction date'); return new Date(value).toISOString(); };

export async function POST(request: NextRequest, { params }: { params: Promise<{ pageId: string; contactId: string }> }) {
    const scope = await authorizeContactProfile(request, params, true);
    if ('error' in scope) return scope.error;
    try {
        const body = await request.json();
        const db = getSupabaseAdmin();
        let result: any;
        if (body.action === 'void_payment') {
            if (!uuid(body.payment_id) || typeof body.reason !== 'string' || body.reason.trim().length < 3) throw new Error('A payment and correction reason are required');
            result = await db.rpc('void_contact_verified_payment', { p_page_id: scope.pageId, p_contact_id: scope.contactId, p_payment_id: body.payment_id, p_actor_id: scope.actorId, p_reason: body.reason.trim() });
        } else {
            if (!uuid(body.request_id) || typeof body.currency !== 'string' || !/^[A-Za-z]{3}$/.test(body.currency)) throw new Error('A valid request ID and currency are required');
            if (body.action === 'purchase') {
                if (typeof body.description !== 'string' || !body.description.trim() || body.description.length > 500) throw new Error('Enter what the customer purchased');
                result = await db.rpc('record_contact_purchase', { p_page_id: scope.pageId, p_contact_id: scope.contactId, p_actor_id: scope.actorId,
                    p_request_id: body.request_id, p_description: body.description.trim(), p_total_minor: parseMoneyMinor(body.amount), p_currency: body.currency.toUpperCase(),
                    p_purchased_at: date(body.occurred_at), p_reference: typeof body.reference === 'string' ? body.reference.slice(0, 160) : null });
            } else if (body.action === 'payment') {
                if (body.confirmed !== true || !['deposit', 'balance', 'full', 'refund'].includes(body.kind)) throw new Error('Confirm the payment against your payment records');
                if (typeof body.reference !== 'string' || body.reference.trim().length < 3 || body.reference.length > 160) throw new Error('Enter a transaction reference');
                if (body.purchase_id && !uuid(body.purchase_id)) throw new Error('Invalid purchase');
                if (body.evidence_message_id && (typeof body.evidence_message_id !== 'string' || body.evidence_message_id.length > 2000)) throw new Error('Invalid evidence message');
                result = await db.rpc('record_contact_verified_payment', { p_page_id: scope.pageId, p_contact_id: scope.contactId, p_actor_id: scope.actorId,
                    p_request_id: body.request_id, p_purchase_id: body.purchase_id || null, p_kind: body.kind, p_amount_minor: parseMoneyMinor(body.amount),
                    p_currency: body.currency.toUpperCase(), p_occurred_at: date(body.occurred_at), p_reference: body.reference.trim(),
                    p_message_id: body.evidence_message_id || null, p_note: typeof body.note === 'string' ? body.note.slice(0, 3000) : '' });
            } else throw new Error('Unknown finance action');
        }
        if (result.error) {
            if (result.error.code === '23505') return NextResponse.json({ error: 'This transaction reference was already recorded. Review the existing payment instead of adding it again.' }, { status: 409 });
            throw new Error(result.error.message || 'Could not save verified records');
        }
        return NextResponse.json({ saved: result.data }, { status: 200 });
    } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid transaction' }, { status: 400 }); }
}
