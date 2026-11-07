import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
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
        if (body.resource !== 'workforce') return NextResponse.json({ error: 'Unknown resource' }, { status: 400 });
        await connectedVeoTenant(body.tenant_id);
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
    const db = getSupabaseAdmin(), result = await db.rpc('veo_handoff', { p_submission: id });
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
