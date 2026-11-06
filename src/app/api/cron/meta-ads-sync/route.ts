import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { decryptMetaAdsToken } from '@/lib/meta-ads-credentials';
import { getUserPageIds } from '@/lib/page-access';
import { refreshMetaAdSpend } from '@/lib/meta-ads-sync';
import { workspaceEnabled } from '@/lib/veo-workspace';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
export async function GET(request: NextRequest) {
    if (!process.env.CRON_SECRET) return NextResponse.json({ error: 'Scheduler is not configured' }, { status: 503 });
    if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const db = getSupabaseAdmin(), deadline = Date.now() + 245000;
    const credentials = await db.from('meta_ads_credentials').select('user_id,token_ciphertext,token_iv,token_auth_tag,token_expires_at').limit(100);
    if (credentials.error) return NextResponse.json({ error: 'Scheduled Meta credentials are unavailable' }, { status: 503 });
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), from = new Date(Date.parse(today + 'T00:00:00Z') - 3 * 86400000).toISOString().slice(0, 10);
    const reports: any[] = [];
    for (const credential of credentials.data || []) {
        try {
            if (Date.now() >= deadline) throw Error('Scheduled ad refresh deadline reached');
            if (credential.token_expires_at && Date.parse(credential.token_expires_at) <= Date.now()) throw Error('Stored Meta ad credential has expired');
            const ids = await getUserPageIds(credential.user_id);
            if (!ids.length) throw Error('No currently authorized Pages are assigned');
            let query = db.from('pages').select('id,fb_page_id').in('id', ids);
            if (workspaceEnabled()) query = query.eq('veo_enabled', true);
            const pages = await query;
            if (pages.error || !pages.data?.length) throw Error('Authorized Pages could not be verified');
            const result = await refreshMetaAdSpend({ db, token: decryptMetaAdsToken(credential), pages: pages.data, from, to: today, deadline,
                authorize: () => getUserPageIds(credential.user_id) });
            reports.push({ user_id: credential.user_id, ...result });
            const saved = await db.from('meta_ads_credentials').update({ ...(result.complete ? { last_synced_at: new Date().toISOString() } : {}), last_error: result.errors.join('; ').slice(0, 300) || null, updated_at: new Date().toISOString() }).eq('user_id', credential.user_id);
            if (saved.error) throw Error('Could not save ad-sync health');
        } catch (error) {
            const message = error instanceof Error ? error.message.slice(0, 300) : 'Scheduled Meta Ads sync failed';
            reports.push({ user_id: credential.user_id, complete: false, errors: [message] });
            await db.from('meta_ads_credentials').update({ last_error: message, updated_at: new Date().toISOString() }).eq('user_id', credential.user_id);
        }
    }
    const complete = reports.length > 0 && reports.every(r => r.complete);
    return NextResponse.json({ complete, reports, finished_at: new Date().toISOString() }, { status: complete ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}
