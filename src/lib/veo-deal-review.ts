import { NextRequest } from 'next/server';
import { getSessionFromRequest } from './get-session';
import { workspaceScope, uuid } from './veo-workspace';
import { dealAmounts } from './veo-deal-amounts';
import { isSupabaseUnavailable } from './supabase-errors';
export const dealEvidenceBucket = 'veo-conversation-submissions';
export const evidenceSlots = ['stage', 'payment', 'order'] as const;
export async function dealReviewScope(request: NextRequest) {
    const session = await getSessionFromRequest(request);
    if (!session?.user?.id) throw Object.assign(Error('Sign in required'), { status: 401 });
    const scope = await workspaceScope(session.user.id, request);
    if (!scope?.launch_at) throw Object.assign(Error('Workspace access is inactive'), { status: 403 });
    if (!scope.reviewed_deals_enabled) throw Object.assign(Error('Reviewed deal submissions are not enabled yet'), { status: 409 });
    return scope;
}
export function dealChecked(result: any) {
    if (result.error) {
        if (isSupabaseUnavailable(result.error)) throw Object.assign(Error('The save could not be confirmed. Refresh the review list before retrying.'), { status: 503 });
        throw Object.assign(Error(result.error.message || 'Deal review unavailable'), { status: result.error.code === '42501' ? 403 : result.error.code === '23505' ? 409 : result.error.code === '23514' ? 422 : 400 });
    }
    return result.data;
}
export function dealSubmission(body: any) {
    if (body.auto_approve != null && typeof body.auto_approve !== 'boolean') throw Error('Choose a valid auto-approval setting');
    if (![body.request_id, body.contact_id, body.seller_id].every(uuid) || !['closed', 'done'].includes(body.receipt_kind) || !Array.isArray(body.photo_ids) || body.photo_ids.length !== 3 || new Set(body.photo_ids).size !== 3 || !body.photo_ids.every(uuid)) throw Error('Select a contact, seller and three different evidence photos');
    for (const key of ['order_id', 'closed_deal_id', 'existing_closed_payment_id']) if (body[key] && !uuid(body[key])) throw Error('Choose a valid existing deal or order');
    const at = Date.parse(body.occurred_at), currency = String(body.currency || 'PHP').toUpperCase();
    if (!Number.isFinite(at) || !/^[A-Z]{3}$/.test(currency)) throw Error('Enter the currency and payment time');
    for (const [key, max] of [['description', 500], ['invoice_reference', 160], ['notes', 2000]] as const) if (body[key] != null && (typeof body[key] !== 'string' || body[key].length > max)) throw Error('Check the description, invoice reference and notes');
    return {
        auto_approve: body.auto_approve !== false, request_id: body.request_id, contact_id: body.contact_id, seller_id: body.seller_id, receipt_kind: body.receipt_kind,
        currency, ...dealAmounts(body),
        occurred_at: new Date(at).toISOString(), description: body.description?.trim() || 'Reviewed video deal', invoice_reference: body.invoice_reference?.trim() || '', notes: body.notes || '',
        order_id: body.order_id || null, closed_deal_id: body.closed_deal_id || null, existing_closed_payment_id: body.existing_closed_payment_id || null
    };
}
