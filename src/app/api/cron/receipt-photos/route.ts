import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { cleanupDeliveredReceiptPhotos } from '@/lib/veo-delivered-photo-cleanup';
import { cleanupWorkspacePhotos } from '@/lib/veo-photo-cleanup';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Reclaim evidence independently of planning, workforce sync and delivery. */
export async function GET(request: NextRequest) {
    if (!process.env.CRON_SECRET || request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (process.env.VEO_WORKSPACE_ENABLED !== 'true') return NextResponse.json({ skipped: true });
    const db = getSupabaseAdmin();
    let delivered: { removed: number } | null = null, expiryRetry = false;
    try { delivered = await cleanupDeliveredReceiptPhotos(db); } catch { /* Retry through the next scheduled run. */ }
    try { await cleanupWorkspacePhotos(db); } catch { expiryRetry = true; }
    const ok = delivered !== null && !expiryRetry;
    return NextResponse.json({ ok, delivered_photos_removed: delivered?.removed || 0, delivered_retry: delivered === null, expiry_retry: expiryRetry },
        { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}
