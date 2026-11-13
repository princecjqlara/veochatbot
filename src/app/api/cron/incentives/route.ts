import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { queueIncentiveNotices } from '@/lib/veo-incentive-delivery';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
export async function GET(r: NextRequest) {
    if (!process.env.CRON_SECRET || r.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (process.env.VEO_WORKSPACE_ENABLED !== 'true') return NextResponse.json({ skipped: true });
    try { return NextResponse.json(await queueIncentiveNotices(getSupabaseAdmin())); }
    catch { return NextResponse.json({ error: 'Incentive queue will retry' }, { status: 503 }); }
}
