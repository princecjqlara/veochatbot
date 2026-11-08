import { NextRequest, NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getSupabaseAdmin } from '@/lib/supabase';
import { uuid } from '@/lib/veo-workspace';
import { connectedVeoTenant, veoDirectory } from '@/lib/veo-jaucian';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
function authenticated(request: NextRequest) {
    const expected = Buffer.from(`Bearer ${process.env.VEO_JAUCIAN_SECRET || ''}`), supplied = Buffer.from(request.headers.get('authorization') || '');
    return !!process.env.VEO_JAUCIAN_SECRET && expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
export async function POST(request: NextRequest) {
    if (!authenticated(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    try {
        const raw = await request.text(); if (Buffer.byteLength(raw) > 2000000) return NextResponse.json({ error: 'Workforce observation batch too large' }, { status: 413 });
        const body = JSON.parse(raw);
        await connectedVeoTenant(body.tenant_id);
        if (body.resource === 'telegram_link') {
            if (!/^[a-f0-9]{48}$/.test(body.code || '') || !Number.isSafeInteger(body.telegram_user_id) || body.telegram_user_id <= 0 || !Number.isSafeInteger(body.chat_id) || body.chat_id >= 0) return NextResponse.json({ error: 'Invalid Telegram link' }, { status: 400 });
            const approved = (process.env.VEO_APPROVED_TELEGRAM_CHAT_IDS || '').split(',').map(v => v.trim());
            if (!approved.includes(String(body.chat_id))) return NextResponse.json({ error: 'Choose an approved VEO group' }, { status: 403 });
            const verified = await (await import('@/lib/veo-jaucian')).jaucianRead(body.tenant_id, { resource: 'identity', chat_id: String(body.chat_id), user_id: String(body.telegram_user_id) });
            if (verified.verified !== true || Number(verified.user_id) !== body.telegram_user_id || Number(verified.chat_id) !== body.chat_id) return NextResponse.json({ error: 'Telegram membership could not be verified' }, { status: 403 });
            const result = await getSupabaseAdmin().rpc('veo_confirm_telegram_link', { p_tenant: body.tenant_id, p_hash: createHash('sha256').update(body.code).digest('hex'), p_telegram: body.telegram_user_id, p_chat: body.chat_id, p_username: verified.username || null });
            if (result.error) return NextResponse.json({ error: result.error.code === '23505' ? 'A different Telegram identity is already linked; ask your supervisor to review it' : 'Link code expired or already used; create a new code in your VEO profile' }, { status: result.error.code === '23505' ? 409 : 400 });
            return NextResponse.json({ ok: true, tenant_id: body.tenant_id, ...result.data }, { headers: { 'Cache-Control': 'no-store' } });
        }
        if (body.resource === 'intake') {
            if (Buffer.byteLength(raw) > 20000) return NextResponse.json({ error: 'Intake request too large' }, { status: 413 });
            const db = getSupabaseAdmin();
            if (['render_notice', 'ack_notice', 'ack_offer'].includes(body.action)) {
                const id = body.data?.notice_id || body.data?.offer_id;
                const approved = (process.env.VEO_APPROVED_TELEGRAM_CHAT_IDS || '').split(',').map(v => v.trim());
                if (!uuid(id) || !Number.isSafeInteger(body.chat_id) || !approved.includes(String(body.chat_id))) return NextResponse.json({ error: 'Invalid notification context' }, { status: 400 });
                if (body.action !== 'render_notice' && (!Number.isSafeInteger(body.data?.message_id) || body.data.message_id <= 0)) return NextResponse.json({ error: 'Invalid Telegram acknowledgment' }, { status: 400 });
                if (body.action === 'ack_offer' && body.data.sent_at !== undefined && (typeof body.data.sent_at !== 'string' || !Number.isFinite(Date.parse(body.data.sent_at)))) return NextResponse.json({ error: 'Invalid Telegram delivery time' }, { status: 400 });
                const result = await db.rpc(body.action === 'render_notice' ? 'veo_intake_notice' : body.action === 'ack_notice' ? 'veo_ack_intake_notice' : 'veo_ack_intake_offer', {
                    p_tenant: body.tenant_id, ...(body.action === 'ack_offer' ? { p_offer: id } : { p_notice: id }), p_chat: body.chat_id,
                    ...(body.action === 'render_notice' ? {} : { p_message: body.data.message_id }),
                    ...(body.action === 'ack_offer' && body.data.sent_at && Number.isFinite(Date.parse(body.data.sent_at)) ? { p_sent_at: new Date(body.data.sent_at).toISOString() } : {})
                });
                if (result.error) return NextResponse.json({ error: 'Notification state unavailable' }, { status: 503 });
                if (body.action === 'render_notice' && !result.data) return NextResponse.json({ error: 'Inquiry or group access changed' }, { status: 409 });
                return NextResponse.json({ ok: true, tenant_id: body.tenant_id, ...(body.action === 'render_notice' ? result.data : { acknowledged: result.data }) }, { headers: { 'Cache-Control': 'no-store' } });
            }
            if (body.action === 'pending') {
                const [pending, notices] = await Promise.all([db.rpc('veo_telegram_intake_pending', { p_tenant: body.tenant_id }), db.rpc('veo_intake_notice_pending', { p_tenant: body.tenant_id })]);
                if (pending.error || notices.error) return NextResponse.json({ error: 'Assignment notifications unavailable' }, { status: 503 });
                return NextResponse.json({ ok: true, tenant_id: body.tenant_id, offers: pending.data, notices: notices.data }, { headers: { 'Cache-Control': 'no-store' } });
            }
            if (!['ready', 'busy', 'pool', 'offers', 'assigned', 'reassign', 'callback', 'render', 'render_offer'].includes(body.action) || !Number.isSafeInteger(body.telegram_user_id) || body.telegram_user_id <= 0 || !Number.isSafeInteger(body.chat_id) || body.chat_id >= 0) return NextResponse.json({ error: 'Invalid Telegram assignment context' }, { status: 400 });
            const data = body.data || {};
            if (body.action === 'render_offer' ? !uuid(data.offer_id) : !uuid(data.request_id)) return NextResponse.json({ error: 'Invalid assignment request reference' }, { status: 400 });
            if (body.action === 'callback' && !uuid(data.token_id)) return NextResponse.json({ error: 'Invalid assignment button' }, { status: 400 });
            const result = await db.rpc('veo_telegram_intake', { p_tenant: body.tenant_id, p_telegram: body.telegram_user_id, p_chat: body.chat_id, p_action: body.action, p_data: { request_id: data.request_id, offer_id: data.offer_id, token_id: data.token_id } });
            if (result.error) return NextResponse.json({ error: result.error.code === '42501' ? result.error.message : 'Assignment could not be updated; refresh the menu' }, { status: result.error.code === '42501' ? 403 : result.error.code === '57014' ? 503 : 400 });
            return NextResponse.json({ ok: true, tenant_id: body.tenant_id, ...result.data }, { headers: { 'Cache-Control': 'no-store' } });
        }
        if (body.resource !== 'workforce') return NextResponse.json({ error: 'Unknown resource' }, { status: 400 });
        const result = await getSupabaseAdmin().rpc('veo_apply_telegram_observations', { p_tenant: body.tenant_id, p_payload: body });
        if (result.error) return NextResponse.json({ error: 'Workforce reconciliation unavailable' }, { status: 503 });
        return NextResponse.json({ ok: true, ...result.data }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (e: any) { return NextResponse.json({ error: e.status ? e.message : 'Invalid workforce observation' }, { status: e.status || 400 }); }
}
export async function GET(request: NextRequest) {
    const expected = Buffer.from(`Bearer ${process.env.VEO_JAUCIAN_SECRET || ''}`), supplied = Buffer.from(request.headers.get('authorization') || '');
    if (!process.env.VEO_JAUCIAN_SECRET || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const resource = request.nextUrl.searchParams.get('resource');
    if (resource) {
        if (resource !== 'directory') return NextResponse.json({ error: 'Invalid resource' }, { status: 400 });
        try {
            return NextResponse.json(await veoDirectory(request.nextUrl.searchParams.get('tenant_id') || ''), { headers: { 'Cache-Control': 'no-store' } });
        } catch (error: any) { return NextResponse.json({ error: error.message }, { status: error.status || 503 }); }
    }
    const reportDate = request.nextUrl.searchParams.get('report_date');
    if (reportDate) {
        const tenant = request.nextUrl.searchParams.get('tenant_id');
        if (!uuid(tenant) || !/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) return NextResponse.json({ error: 'Invalid report' }, { status: 400 });
        try { await connectedVeoTenant(tenant); }
        catch (error: any) { return NextResponse.json({ error: error.message }, { status: error.status || 503 }); }
        const result = await getSupabaseAdmin().rpc(request.nextUrl.searchParams.get('include_operations') === '1' ? 'veo_operations_report' : 'veo_jaucian_report', { p_tenant: tenant, p_day: reportDate });
        return NextResponse.json(result.error ? { error: 'Report unavailable' } : result.data, { status: result.error ? 503 : 200, headers: { 'Cache-Control': 'no-store' } });
    }
    const id = request.nextUrl.searchParams.get('submission_id');
    if (!uuid(id)) return NextResponse.json({ error: 'Invalid submission' }, { status: 400 });
    const db = getSupabaseAdmin();
    // The source worker refreshes Facebook evidence independently. Keep this
    // retry path bounded and let the database validate the saved evidence.
    const result = await db.rpc('veo_handoff', { p_submission: id });
    if (result.error) return NextResponse.json({ error: 'Eligibility unavailable' }, { status: 503 });
    if (!result.data) {
        const deleted = await db.rpc('veo_submission_receipt_deleted', {p_submission:id});
        if (deleted.error) return NextResponse.json({error:'Submission state unavailable'},{status:503});
        if (deleted.data === true) return NextResponse.json({error:'Receipt deleted; delivery cancelled',code:'RECEIPT_DELETED'},{status:410});
        return NextResponse.json({ error: 'Submission ineligible or expired' }, { status: 409 });
    }
    const s = await db.from('veo_submissions').select('object_path,status,deleted_at').eq('id', id).single();
    if (s.error) return NextResponse.json({ error: 'Submission state unavailable' }, { status: 503 });
    if (!s.data || ['blocked', 'expired'].includes(s.data.status)) return NextResponse.json({ error: 'Submission was blocked or expired; review and re-upload' }, { status: 409 });
    if (s.data.deleted_at) return NextResponse.json({ error: 'Temporary photo was deleted' }, { status: 410 });
    const signed = s.data && await db.storage.from('veo-conversation-submissions').createSignedUrl(s.data.object_path, 60);
    if (!signed || signed.error) return NextResponse.json({ error: 'Photo unavailable; re-upload required' }, { status: 410 });
    return NextResponse.json({ ...result.data, photo_url: signed.data.signedUrl }, { headers: { 'Cache-Control': 'no-store' } });
}
