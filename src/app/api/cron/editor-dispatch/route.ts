import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
/** Editor offers must not wait behind photo cleanup, workforce scans or AI work.
 * Each tenant's database tick has its own nonblocking transaction lock. */
export async function GET(request: Request) {
    if (!process.env.CRON_SECRET || request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (process.env.VEO_WORKSPACE_ENABLED !== 'true') return NextResponse.json({ skipped: true });
    try {
        const db = getSupabaseAdmin();
        const policies = await db.from('veo_intake_auto_policy').select('tenant_id').eq('enabled', true).limit(10);
        if (policies.error) throw Error('Editor dispatch configuration unavailable');
        let failed = 0, announced = 0, offered = 0;
        for (const policy of policies.data || []) {
            const result = await db.rpc('veo_automatic_intake_tick', { p_tenant: policy.tenant_id });
            if (result.error) failed++;
            else { announced += Number(result.data?.new_announcements || 0);offered += Number(result.data?.offered || 0); }
        }
        return NextResponse.json({ ok: failed === 0, tenants: policies.data?.length || 0, announced, offered, failed }, { status: failed ? 503 : 200, headers: { 'Cache-Control': 'no-store' } });
    } catch { return NextResponse.json({ ok: false, error: 'Editor dispatch will retry' }, { status: 503 }); }
}
