import { NextRequest, NextResponse } from 'next/server';
import { recoverFirstInquiries } from '@/lib/veo-inquiry-history';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;
export async function GET(r: NextRequest) {
    if (!process.env.CRON_SECRET || r.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (process.env.VEO_WORKSPACE_ENABLED !== 'true') return NextResponse.json({ skipped: true });
    try { const result = await recoverFirstInquiries(); return NextResponse.json(result, { status: result.failed ? 503 : 200 }); }
    catch { return NextResponse.json({ error: 'Inquiry history verification will retry' }, { status: 503 }); }
}
