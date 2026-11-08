import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { processWorkspaceEvents } from '@/lib/veo-events';
import { POST as processFacebookWebhook } from '@/app/api/facebook/webhook/route';
import { syncTelegramWorkforce } from '@/lib/veo-telegram-sync';
import { refreshPageBudgets } from '@/lib/veo-budget';
import { refreshSubmissionFacebook } from '@/lib/veo-facebook-check';
import { processJevInterruptionReviews } from '@/lib/veo-jev-review';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
    if (!process.env.CRON_SECRET || request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (process.env.VEO_WORKSPACE_ENABLED !== 'true') return NextResponse.json({ enabled: false });
    const db = getSupabaseAdmin();
    const startedAt = Date.now();
    try {
        // Expiry is enforced independently of delivery. A failed deletion remains visible and retries.
        const cleanup = await db.from('veo_submissions').select('id,object_path,expires_at,status').is('deleted_at', null)
            .or(`status.eq.delivered,expires_at.lte.${new Date().toISOString()}`).limit(30);
        if (cleanup.error) throw new Error('Photo cleanup unavailable');
        for (const s of cleanup.data || []) {
            const removed = await db.storage.from('veo-conversation-submissions').remove([s.object_path]);
            if (removed.error) throw new Error('Temporary photo deletion pending');
            const objectSaved = await db.from('veo_photo_objects').update({ deleted_at: new Date().toISOString() }).eq('object_path', s.object_path);
            if (objectSaved.error) throw new Error('Photo deletion metadata unavailable');
            const saved = await db.from('veo_submissions').update({ deleted_at: new Date().toISOString(), ...(s.status === 'delivered' ? {} : { status: 'expired', last_error: 'Photo expired; re-upload required' }) }).eq('id', s.id);
            if (saved.error) throw new Error('Photo deletion checkpoint unavailable');
        }
        const orphans = await db.from('veo_photo_objects').select('object_path').is('deleted_at', null).lte('expires_at', new Date().toISOString()).limit(30);
        if (orphans.error) throw new Error('Temporary photo expiry scan unavailable');
        for (const item of orphans.data || []) {
            const removed = await db.storage.from('veo-conversation-submissions').remove([item.object_path]);
            if (removed.error) throw new Error('Expired photo deletion pending');
            const saved = await db.from('veo_photo_objects').update({ deleted_at: new Date().toISOString() }).eq('object_path', item.object_path);
            if (saved.error) throw new Error('Expired photo checkpoint unavailable');
        }

        const maintained = await db.rpc('veo_maintenance');
        if (maintained.error) throw new Error('Salary finalization unavailable');
        let integration: any = { retry: true }, operations: any = { error: true };
        try { integration = await syncTelegramWorkforce(); } catch { /* Retry independently of new-event collection. */ }
        try { operations = await db.rpc('veo_operations_maintenance'); } catch { /* Preserve collection during a planning outage. */ }
        let intakeRetry = false;
        try { const cleaned = await db.rpc('veo_telegram_intake_maintenance');intakeRetry = !!cleaned.error; } catch { intakeRetry = true; }
        try {
            const tenants = await db.from('veo_intake_auto_policy').select('tenant_id').eq('enabled', true).limit(10);
            if (tenants.error) intakeRetry = true;
            for (const tenant of tenants.data || []) {
                const dispatched = await db.rpc('veo_automatic_intake_tick', { p_tenant: tenant.tenant_id });
                if (dispatched.error) intakeRetry = true;
            }
        } catch { intakeRetry = true; }
        try { await processJevInterruptionReviews({ limit: 1, timeBudgetMs: 20000 }); } catch { /* Keep the bot paused and retry independently of editor dispatch. */ }
        let budgetRetry = false;
        try { await refreshPageBudgets(); } catch { budgetRetry = true; }
        const processed = await processWorkspaceEvents(processFacebookWebhook, request.nextUrl.origin, Math.max(0, 210000 - (Date.now() - startedAt)));
        const claimed = await db.rpc('veo_claim_submissions');
        if (claimed.error) throw new Error('Delivery queue unavailable');
        for (const s of claimed.data || []) {
            let status = 'queued', failure: string | null = null;
            try {
                // Leave time to finish the lease after a bounded Facebook read
                // and Jaucian request; later items retry on the next cron run.
                if (Date.now() - startedAt > 240000) throw new Error('Delivery budget exhausted');
                await refreshSubmissionFacebook(db, s.id);
                const eligibility = await db.rpc('veo_handoff', { p_submission: s.id });
                if (eligibility.error) throw new Error('Eligibility read failed');
                if (!eligibility.data) { status = 'blocked'; failure = 'Eligibility or page access changed; review and resubmit'; }
                else {
                    const target = new URL('/api/veo/handoff', process.env.VEO_JAUCIAN_URL);
                    if (target.protocol !== 'https:') throw new Error('Secure Jaucian URL required');
                    const response = await fetch(target, { method: 'POST', headers: { Authorization: `Bearer ${process.env.VEO_JAUCIAN_SECRET}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify(eligibility.data), signal: AbortSignal.timeout(15000) });
                    const receipt = await response.json();
                    if (!response.ok || !receipt.ok) throw new Error('Jaucian handoff unavailable');
                    if (receipt.status === 'sent') status = 'delivered';
                    if (receipt.status === 'cancelled') { status = 'blocked'; failure = 'Telegram acknowledgment requires reconciliation; duplicate resend suppressed'; }
                }
            } catch { failure = 'Delivery pending; automatic retry scheduled'; }
            const finished = await db.rpc('veo_finish_submission', { p_id: s.id, p_claim: s.claim_token, p_status: status, p_error: failure });
            if (finished.error || !finished.data) throw new Error('Delivery lease lost');
        }
        return NextResponse.json({ ok: true, processed, submissions: claimed.data?.length || 0, integration, budget_retry: budgetRetry, intake_retry: intakeRetry, operations_retry: !!operations.error, cleanup: operations.data || null });
    } catch (e: any) { return NextResponse.json({ ok: false, error: e.message }, { status: 503 }); }
}
