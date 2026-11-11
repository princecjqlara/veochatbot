import { NextRequest, NextResponse } from 'next/server';
import { runScheduledMetaAds } from '@/lib/veo-scheduled-ads';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
export async function GET(request: NextRequest) {
    if (!process.env.CRON_SECRET) return NextResponse.json({ error: 'Scheduler is not configured' }, { status: 503 });
    if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    try {
        const result = await runScheduledMetaAds();
        return NextResponse.json(result, { status: result.complete || result.skipped ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
    } catch { return NextResponse.json({complete:false,error:'Scheduled Meta Ads sync is temporarily unavailable'},{status:503}); }
}
