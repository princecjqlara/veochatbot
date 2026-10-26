import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { userHasPageAccess } from '@/lib/page-access';
import { getSupabaseAdmin } from '@/lib/supabase';
import { safeAdMediaUrl } from '@/lib/ad-attribution';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;
export async function POST(request: NextRequest) {
    const session = await getSessionFromRequest(request);
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const origin = request.headers.get('origin');
    if (origin !== request.nextUrl.origin) return NextResponse.json({ error: 'Same-origin request required' }, { status: 403 });
    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
    if (typeof body.pageId !== 'string' || !Array.isArray(body.adIds) || body.adIds.length > 20 || !body.adIds.every((x: unknown) => typeof x === 'string' && /^\d{1,100}$/.test(x))) return NextResponse.json({ error: 'Choose at most 20 recorded ad IDs' }, { status: 400 });
    if (!await userHasPageAccess(session.user.id, body.pageId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const db = getSupabaseAdmin();
    const [{ data: page }, { data: known, error }] = await Promise.all([
        db.from('pages').select('access_token').eq('id', body.pageId).single(),
        db.from('ad_source_catalog').select('ad_id').eq('page_id', body.pageId).in('ad_id', body.adIds)
    ]);
    if (error) return NextResponse.json({ error: 'Could not load recorded ads' }, { status: 503 });
    const token = session.accessToken || page?.access_token;
    if (!token) return NextResponse.json({ error: 'Connect a Facebook account with access to these ads' }, { status: 409 });
    const results = [];
    for (const ad of known || []) {
        try {
            const url = new URL(`https://graph.facebook.com/v21.0/${ad.ad_id}`);
            url.searchParams.set('fields', 'id,name,campaign{id,name},adset{id,name},creative{id,name,thumbnail_url,effective_object_story_id}');
            const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(5000) });
            const data = await response.json();
            if (!response.ok || data.error || data.id !== ad.ad_id) { results.push({ adId: ad.ad_id, resolved: false }); continue; }
            const saved = await db.from('ad_source_catalog').upsert({ page_id: body.pageId, ad_id: ad.ad_id,
                ad_name: typeof data.name === 'string' ? data.name.slice(0, 500) : null,
                creative_id: data.creative?.id || null, creative_name: data.creative?.name || null,
                campaign_id: data.campaign?.id || null, campaign_name: data.campaign?.name || null,
                adset_id: data.adset?.id || null, adset_name: data.adset?.name || null,
                ...(safeAdMediaUrl(data.creative?.thumbnail_url) ? { photo_url: safeAdMediaUrl(data.creative.thumbnail_url) } : {}),
                ...(typeof data.creative?.effective_object_story_id === 'string' ? { post_id: data.creative.effective_object_story_id } : {}),
                metadata_source: 'marketing_api', metadata_checked_at: new Date().toISOString(), updated_at: new Date().toISOString()
            }, { onConflict: 'page_id,ad_id' });
            results.push({ adId: ad.ad_id, resolved: !saved.error });
        } catch { results.push({ adId: ad.ad_id, resolved: false }); }
    }
    return NextResponse.json({ results, note: 'Unresolved ads need ad-account access or may no longer be available. Recorded ad IDs and lead counts remain usable.' });
}
