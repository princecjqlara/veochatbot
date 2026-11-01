import { NextRequest, NextResponse } from 'next/server';
import { processContactProfiles } from '@/lib/contact-profile-worker';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
export async function GET(request: NextRequest) {
    if (!process.env.CRON_SECRET) return NextResponse.json({ error: 'Scheduler is not configured' }, { status: 503 });
    if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    try { const result = await processContactProfiles({ limit: 2, budgetMs: 120000 }); return NextResponse.json(result, { status: result.failed ? 503 : 200 }); }
    catch { return NextResponse.json({ error: 'Contact profile worker is temporarily unavailable' }, { status: 503 }); }
}
