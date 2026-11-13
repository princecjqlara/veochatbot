import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { processWorkspaceEvents } from '@/lib/veo-events';
import { runBackgroundJob } from '@/lib/background-run';
import { POST as webhook } from '@/app/api/facebook/webhook/route';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;
export async function GET(request: NextRequest) {
    if (!process.env.CRON_SECRET || request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (process.env.VEO_WORKSPACE_ENABLED !== 'true') return NextResponse.json({ skipped: true });
    try {
        const result = await runBackgroundJob('workspace-events', async () => {
            const recovered = await getSupabaseAdmin().rpc('veo_recover_queued_contact_identities', { p_limit: 1000 });
            if (recovered.error) throw Error('Pending client recovery unavailable');
            const processed = await processWorkspaceEvents(webhook, request.nextUrl.origin, 140000, { maxEvents: 1000 });
            return { ok: true, contacts_recovered: Number(recovered.data || 0), processed };
        });
        return NextResponse.json(result);
    } catch { return NextResponse.json({ ok: false, error: 'Live event processing needs retry' }, { status: 503 }); }
}
