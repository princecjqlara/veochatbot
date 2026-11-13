import { NextRequest, NextResponse } from 'next/server';
import { syncAutomaticContactIdentities } from '@/lib/veo-automatic-contact-sync';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function GET(request: NextRequest) {
    if (!process.env.CRON_SECRET || request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (process.env.VEO_WORKSPACE_ENABLED !== 'true') return NextResponse.json({ skipped: true });
    try { const result = await syncAutomaticContactIdentities();return NextResponse.json({ ok: result.failed === 0, ...result }, { status: result.failed ? 503 : 200 }); }
    catch { return NextResponse.json({ ok: false, error: 'Automatic contact sync will retry' }, { status: 503 }); }
}
