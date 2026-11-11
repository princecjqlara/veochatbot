import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getUserPageIds } from '@/lib/page-access';
import { refreshStoredWorkspaceAds } from '@/lib/veo-stored-ads-refresh';
import { workspaceEnabled } from '@/lib/veo-workspace';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
export async function GET(request: NextRequest) {
    if (!process.env.CRON_SECRET) return NextResponse.json({ error: 'Scheduler is not configured' }, { status: 503 });
    if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const db = getSupabaseAdmin(), deadline = Date.now() + 245000;
    const credentials = await db.from('meta_ads_credentials').select('user_id,token_expires_at,sync_checkpoint').limit(100);
    if (credentials.error) return NextResponse.json({ error: 'Scheduled Meta credentials are unavailable' }, { status: 503 });
    if (!credentials.data?.length) return NextResponse.json({ complete: false, skipped: true, reason: 'connect_meta_ads_required', reports: [] }, { headers: { 'Cache-Control': 'no-store' } });
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), from = new Date(Date.parse(today + 'T00:00:00Z') - 3 * 86400000).toISOString().slice(0, 10);
    const reports: any[] = [];
    for (const credential of credentials.data || []) {
        try {
            if (Date.now() >= deadline) throw Error('Scheduled ad refresh deadline reached');
            if (credential.token_expires_at && Date.parse(credential.token_expires_at) <= Date.now()) throw Error('Stored Meta ad credential has expired');
            const checkpoint = credential.sync_checkpoint;
            const validDay = (v: unknown): v is string => typeof v === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v+'T00:00:00Z').toISOString().slice(0,10) === v;
            const resume = checkpoint && validDay(checkpoint.from) && validDay(checkpoint.to) && checkpoint.from <= checkpoint.to && checkpoint.to <= today && Date.parse(checkpoint.to)-Date.parse(checkpoint.from) <= 92*86400000;
            const result = await refreshStoredWorkspaceAds({ db, user: credential.user_id, from: resume ? checkpoint.from : from, to: resume ? checkpoint.to : today, deadline, workspaceOnly: workspaceEnabled(), preserveOtherCheckpoint: true,
                authorize: () => getUserPageIds(credential.user_id) });
            reports.push({ user_id: credential.user_id, ...result });
        } catch (error) {
            if ((error as any)?.status === 409 && !(error as any)?.requiresReconnect) { reports.push({ user_id: credential.user_id, complete: true, skipped: true, reason: 'Refresh already running' }); continue; }
            const message = error instanceof Error ? error.message.slice(0, 300) : 'Scheduled Meta Ads sync failed';
            reports.push({ user_id: credential.user_id, complete: false, errors: [message] });
            await db.from('meta_ads_credentials').update({ last_error: message, updated_at: new Date().toISOString() }).eq('user_id', credential.user_id);
        }
    }
    const complete = reports.length > 0 && reports.every(r => r.complete);
    return NextResponse.json({ complete, reports, finished_at: new Date().toISOString() }, { status: complete ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}
