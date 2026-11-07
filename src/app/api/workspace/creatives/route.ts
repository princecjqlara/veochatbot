import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { workspaceScope, uuid, philippineDate } from '@/lib/veo-workspace';
import { adQualityRange } from '@/lib/ad-quality-range';
import { readVeoRpc } from '@/lib/veo-report-read';
import { buildCreativeReport } from '@/lib/veo-creative-analytics';
import { decryptMetaAdsToken } from '@/lib/meta-ads-credentials';
import { readMetaAds } from '@/lib/facebook-ad-catalog';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
export async function GET(request: NextRequest) {
    try {
        const session = await getSessionFromRequest(request);
        if (!session?.user?.id) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
        const scope = await workspaceScope(session.user.id), q = request.nextUrl.searchParams, page = q.get('pageId') || q.get('page_id'), ad = q.get('ad_id') || null;
        if (!scope?.launch_at || !['owner', 'team_leader'].includes(scope.role)) return NextResponse.json({ error: 'Owner or Team Leader required' }, { status: 403 });
        if (!uuid(page) || !scope.page_ids.includes(page)) return NextResponse.json({ error: 'Select one assigned Page for creative reporting' }, { status: 400 });
        if (ad && !/^\d{1,100}$/.test(ad)) throw Error('Choose a creative');
        const range = adQualityRange(q), to = philippineDate(new Date(Date.parse(range.to) - 1)), from = range.from ? philippineDate(new Date(range.from)) : new Date(Date.parse(to) - 29 * 86400000).toISOString().slice(0, 10);
        if (Date.parse(to) - Date.parse(from) > 92 * 86400000) throw Error('Choose at most 93 days for creative analytics');
        const db = getSupabaseAdmin(), result = await readVeoRpc(db, 'veo_creative_inputs', { p_actor: scope.user_id, p_page: page, p_from: from, p_to: to, p_ad: ad });
        if (result.error) throw Object.assign(Error('Creative report is temporarily unavailable. Retry shortly.'), { status: result.error.code === '42501' ? 403 : 503 });
        const report: any = buildCreativeReport(result.data); report.exact_frequency = null;
        if (ad && report.ads.some((a: any) => a.ad_id === ad)) {
            try {
                const tenant = await db.from('veo_tenants').select('owner_id').eq('id', scope.tenant_id).single();
                if (tenant.error || !tenant.data) throw Error('Ad credential owner unavailable');
                const credential = await db.from('meta_ads_credentials').select('token_ciphertext,token_iv,token_auth_tag,token_expires_at').eq('user_id', tenant.data.owner_id).maybeSingle();
                if (credential.data && (!credential.data.token_expires_at || Date.parse(credential.data.token_expires_at) > Date.now())) {
                    const raw = await readMetaAds(ad + '/insights', decryptMetaAdsToken(credential.data), { fields: 'ad_id,frequency,reach,impressions', time_range: JSON.stringify({ since: from, until: to }), level: 'ad', limit: '1' });
                    const value = raw.data?.[0]; if (value?.ad_id === ad && Number.isFinite(Number(value.frequency))) report.exact_frequency = { value: Number(value.frequency), checked_at: new Date().toISOString(), from, to, timezone: 'Ad-account reporting dates' };
                }
            } catch { /* Saved metrics remain usable; no fabricated range frequency. */ }
        }
        return NextResponse.json(report, { headers: { 'Cache-Control': 'no-store' } });
    } catch (e: any) { return NextResponse.json({ error: e.message || 'Creative analytics unavailable' }, { status: e.status || (e.code === 'DATABASE_UNAVAILABLE' ? 503 : 400), headers: { 'Cache-Control': 'no-store' } }); }
}
