import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getUserPageIds } from '@/lib/page-access';
import { getSupabaseAdmin } from '@/lib/supabase';
import { adQualityRange } from '@/lib/ad-quality-range';
import{qualityForAdRow}from'@/lib/lead-quality';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function GET(request: NextRequest) {
    const session = await getSessionFromRequest(request);
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    let range;
    try { range = adQualityRange(request.nextUrl.searchParams); }
    catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
    try {
        const memberships = await getUserPageIds(session.user.id), requested = request.nextUrl.searchParams.get('pageId');
        if (requested && !memberships.includes(requested)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        const ids = requested ? [requested] : memberships;
        if (!ids.length) return NextResponse.json({ range, pages: [], generated_at: range.generated_at }, { headers: { 'Cache-Control': 'no-store' } });
        const db = getSupabaseAdmin();
        const { data: pages, error } = await db.from('pages').select('id,name,fb_page_id').in('id', ids);
        if (error) throw error;
        const catalogResult=await db.rpc('get_visible_ad_catalog',{p_page_ids:ids,p_from:range.from,p_to:range.to});
        const catalog=Array.isArray(catalogResult.data)?catalogResult.data:[];
        const reports = [];
        // Bounded concurrency avoids a query burst when an owner has many Pages.
        for (let offset = 0; offset < (pages || []).length; offset += 5) {
            reports.push(...await Promise.all((pages || []).slice(offset, offset + 5).map(async page => {
                const result = await db.rpc('get_ad_lead_quality', { p_page_id: page.id, p_from: range.from, p_to: range.to });
                if (result.error) throw result.error;
                const rows=(result.data.rows||[]).map((r:any)=>({...r,lead_quality:qualityForAdRow(r)}));
                return { page, ...result.data,rows, tracked_ads:catalog.filter((a:any)=>a.page_id===page.id) };
            })));
        }
        return NextResponse.json({ range, pages: reports, generated_at: range.generated_at,catalog_warning:catalogResult.error?'Ad inventory is temporarily unavailable. Recorded lead counts remain visible.':null }, { headers: { 'Cache-Control': 'no-store' } });
    } catch {
        return NextResponse.json({ error: 'Ad-quality reporting is temporarily unavailable. Retry shortly.' }, { status: 503 });
    }
}
