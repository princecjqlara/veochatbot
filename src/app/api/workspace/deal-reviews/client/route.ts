import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { dealReviewScope } from '@/lib/veo-deal-review';
import { uuid } from '@/lib/veo-workspace';
import { readVeoRpc } from '@/lib/veo-report-read';
import { isSupabaseUnavailable } from '@/lib/supabase-errors';

export const dynamic = 'force-dynamic';
export const maxDuration = 45;
const reply = (body: any, status = 200) => NextResponse.json(body, {
    status, headers: { 'Cache-Control': 'no-store', ...(status === 503 ? { 'Retry-After': '5' } : {}) }
});
function checked(result: any) {
    if (result.error) throw Object.assign(Error(result.error.message), {
        status: result.error.code === '42501' ? 403 : isSupabaseUnavailable(result.error) ? 503 : 400
    });
    return result.data;
}

/** The receipt form needs current seller orders, not a complete client profile. */
export async function GET(request: NextRequest) {
    try {
        const scope = await dealReviewScope(request), params = request.nextUrl.searchParams;
        const contactId = params.get('contact_id'), sellerId = params.get('seller_id');
        if (!uuid(contactId) || !uuid(sellerId)) return reply({ error: 'Select a client and selling staff account.' }, 400);
        const db = getSupabaseAdmin();
        // This is the same live Page, branch, seller and suspension check used
        // before accepting evidence uploads. Browser account lists are not authority.
        const access = checked(await readVeoRpc(db, 'veo_deal_review_context', { p_actor: scope.user_id, p_contact: contactId, p_seller: sellerId }, 20000));
        if (access?.contact_id !== contactId || access?.seller_id !== sellerId) throw Object.assign(Error('Client access could not be confirmed.'), { status: 503 });
        const [contact, orders, closedDeals] = await Promise.all([
            db.from('contacts').select('id,page_id,name,psid,pipeline_stage').eq('id', contactId).maybeSingle(),
            db.from('veo_order_facts').select('id,seller_id,description,total_minor,paid_minor,currency,done_at').eq('contact_id', contactId).eq('seller_id', sellerId),
            db.from('veo_closed_deals').select('id,order_id,amount_minor,currency,occurred_at,verified_payment_id,seller_id').eq('contact_id', contactId).eq('seller_id', sellerId).is('voided_at', null)
        ]);
        const client = checked(contact), sellerOrders = checked(orders) || [], deals = checked(closedDeals) || [];
        if (!client) return reply({ error: 'This client is no longer available. Select the client again.' }, 404);
        const payments = sellerOrders.length ? checked(await db.from('veo_payments').select('id,order_id,kind,amount_minor,reference,occurred_at').in('order_id', sellerOrders.map((order: any) => order.id)).order('occurred_at')) : [];
        return reply({ contact: client, orders: sellerOrders, closed_deals: deals, payments: payments || [] });
    } catch (error: any) {
        const status = error.status || 503;
        return reply({ error: status === 503 ? 'Client orders are temporarily unavailable. Your client details have not been removed. Please retry.' : error.message || 'Client unavailable.' }, status);
    }
}
