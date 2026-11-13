import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
export async function GET(r: NextRequest) {
    if (!process.env.CRON_SECRET || r.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (process.env.VEO_WORKSPACE_ENABLED !== 'true') return NextResponse.json({ skipped: true });
    const result = await getSupabaseAdmin().rpc('veo_refresh_spend_quotas');
    return NextResponse.json(result.error ? { error: 'Quota refresh will retry' } : result.data, { status: result.error ? 503 : 200 });
}
