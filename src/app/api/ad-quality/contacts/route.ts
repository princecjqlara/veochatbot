import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { userHasPageAccess } from '@/lib/page-access';
import { getSupabaseAdmin } from '@/lib/supabase';
import { adQualityRange } from '@/lib/ad-quality-range';
import { CONTACT_PIPELINE_STAGES } from '@/lib/contact-pipeline';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
    const session = await getSessionFromRequest(request);
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const q = request.nextUrl.searchParams, pageId = q.get('pageId');
    if (!pageId) return NextResponse.json({ error: 'Choose a Page' }, { status: 400 });
    if (!await userHasPageAccess(session.user.id, pageId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    let range;
    try { range = adQualityRange(q); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
    const adId = q.get('adId'), stage = q.get('stage');
    if (adId && !/^\d{1,100}$/.test(adId) || stage && !CONTACT_PIPELINE_STAGES.includes(stage as any)) return NextResponse.json({ error: 'Invalid ad or stage filter' }, { status: 400 });
    const offset = Number(q.get('offset') || '0');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) return NextResponse.json({ error: 'Invalid pagination' }, { status: 400 });
    const { data, error } = await getSupabaseAdmin().rpc('get_ad_lead_contacts', {
        p_page_id: pageId, p_from: range.from, p_to: range.to, p_ad_id: adId,
        p_unknown: q.get('unknown') === 'true', p_stage: stage, p_limit: 25, p_offset: offset
    });
    if (error) return NextResponse.json({ error: 'Could not load ad contacts' }, { status: 503 });
    return NextResponse.json({ ...data, range, offset, limit: 25 }, { headers: { 'Cache-Control': 'no-store' } });
}
