import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { getSupabaseAdmin } from '@/lib/supabase';
import { uuid } from '@/lib/veo-workspace';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
    const expected = Buffer.from(`Bearer ${process.env.VEO_JAUCIAN_SECRET || ''}`), supplied = Buffer.from(request.headers.get('authorization') || '');
    if (!process.env.VEO_JAUCIAN_SECRET || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const reportDate = request.nextUrl.searchParams.get('report_date');
    if (reportDate) {
        const tenant = request.nextUrl.searchParams.get('tenant_id');
        if (!uuid(tenant) || !/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) return NextResponse.json({ error: 'Invalid report' }, { status: 400 });
        const result = await getSupabaseAdmin().rpc('veo_jaucian_report', { p_tenant: tenant, p_day: reportDate });
        return NextResponse.json(result.error ? { error: 'Report unavailable' } : result.data, { status: result.error ? 503 : 200, headers: { 'Cache-Control': 'no-store' } });
    }
    const id = request.nextUrl.searchParams.get('submission_id');
    if (!uuid(id)) return NextResponse.json({ error: 'Invalid submission' }, { status: 400 });
    const db = getSupabaseAdmin(), result = await db.rpc('veo_handoff', { p_submission: id });
    if (result.error) return NextResponse.json({ error: 'Eligibility unavailable' }, { status: 503 });
    if (!result.data) return NextResponse.json({ error: 'Submission ineligible or expired' }, { status: 409 });
    const s = await db.from('veo_submissions').select('object_path,status,deleted_at').eq('id', id).single();
    if (s.error) return NextResponse.json({ error: 'Submission state unavailable' }, { status: 503 });
    if (!s.data || ['blocked', 'expired'].includes(s.data.status)) return NextResponse.json({ error: 'Submission was blocked or expired; review and re-upload' }, { status: 409 });
    if (s.data.deleted_at) return NextResponse.json({ error: 'Temporary photo was deleted' }, { status: 410 });
    const signed = s.data && await db.storage.from('veo-conversation-submissions').createSignedUrl(s.data.object_path, 60);
    if (!signed || signed.error) return NextResponse.json({ error: 'Photo unavailable; re-upload required' }, { status: 410 });
    return NextResponse.json({ ...result.data, photo_url: signed.data.signedUrl }, { headers: { 'Cache-Control': 'no-store' } });
}
