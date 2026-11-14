import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { readStorageMetrics } from '@/lib/veo-storage-health';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
export async function GET(request: NextRequest) {
    if (!process.env.CRON_SECRET || request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (process.env.VEO_WORKSPACE_ENABLED !== 'true') return NextResponse.json({ skipped: true });
    const db = getSupabaseAdmin();let metrics: any = { available: false };
    try { metrics = await readStorageMetrics(); } catch { /* Record unavailable monitoring instead of a healthy result. */ }
    try {
        const recorded = await db.rpc('veo_record_storage_metrics', { p_metrics: metrics });
        if (recorded.error || !recorded.data) throw Error('Storage monitor checkpoint unavailable');
        const healthy = recorded.data.status === 'healthy' && recorded.data.maintenance_healthy && recorded.data.resource_metrics_fresh === true && recorded.data.resource_pressure === false;
        if (!healthy) console.warn('[DATABASE_HEALTH] Database requires attention', { status: recorded.data.status, maintenanceHealthy: recorded.data.maintenance_healthy,
            resourceMetricsFresh: recorded.data.resource_metrics_fresh, resourcePressure: recorded.data.resource_pressure_reasons });
        return NextResponse.json({ ok: healthy, ...recorded.data }, { status: healthy ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
    } catch { return NextResponse.json({ ok: false, error: 'Storage health is temporarily unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
}
