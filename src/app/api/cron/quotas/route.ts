import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { requireStorageForOptionalWork } from '@/lib/veo-storage-health';
import { refreshQuotaSnapshots } from '@/lib/veo-quota-refresh';
import { runBackgroundJob } from '@/lib/background-run';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
export async function GET(r: NextRequest) {
    if (!process.env.CRON_SECRET || r.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (process.env.VEO_WORKSPACE_ENABLED !== 'true') return NextResponse.json({ skipped: true });
    const db = getSupabaseAdmin();
    try { await requireStorageForOptionalWork(db); }
    catch { return NextResponse.json({ skipped: true, reason: 'database_pressure', retryable: true }, { status: 503, headers: { 'Retry-After': '60' } }); }
    try {
        const result = await runBackgroundJob('quotas', () => refreshQuotaSnapshots(db), db);
        return NextResponse.json(result, { status: 'failed' in result && result.failed ? 503 : 200, headers: {'Cache-Control':'no-store'} });
    } catch { return NextResponse.json({ error: 'Quota refresh will retry' }, { status: 503 }); }
}
