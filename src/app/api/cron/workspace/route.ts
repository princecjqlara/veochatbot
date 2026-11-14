import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { processWorkspaceEvents } from '@/lib/veo-events';
import { POST as processFacebookWebhook } from '@/app/api/facebook/webhook/route';
import { syncTelegramWorkforce } from '@/lib/veo-telegram-sync';
import { refreshPageBudgets } from '@/lib/veo-budget';
import { processJevInterruptionReviews } from '@/lib/veo-jev-review';
import { processVeoSourceJobs } from '@/lib/veo-source-jobs';
import { cleanupWorkspacePhotos } from '@/lib/veo-photo-cleanup';
import { runBackgroundJob } from '@/lib/background-run';
import { queueReceiptDeletions } from '@/lib/veo-receipt-deletion';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
    if (!process.env.CRON_SECRET || request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (process.env.VEO_WORKSPACE_ENABLED !== 'true') return NextResponse.json({ enabled: false });
    try {
        const result = await runBackgroundJob('workspace', () => processWorkspace(request));
        return result instanceof NextResponse ? result : NextResponse.json(result);
    } catch {
        return NextResponse.json({ ok: false, error: 'Workspace worker is temporarily unavailable' }, { status: 503 });
    }
}
async function processWorkspace(request: NextRequest) {
    const db = getSupabaseAdmin();
    const startedAt = Date.now();
    try {
        // Expiry is enforced independently of delivery. A failed deletion remains visible and retries.
        const receiptDeletion = await queueReceiptDeletions(db);
        await cleanupWorkspacePhotos(db);

        const maintained = await db.rpc('veo_maintenance');
        if (maintained.error) throw new Error('Salary finalization unavailable');
        let integration: any = { retry: true }, operations: any = { error: true };
        try { integration = await syncTelegramWorkforce(); } catch { /* Retry independently of new-event collection. */ }
        try { operations = await db.rpc('veo_operations_maintenance'); } catch { /* Preserve collection during a planning outage. */ }
        let intakeRetry = false;
        try { const cleaned = await db.rpc('veo_telegram_intake_maintenance');intakeRetry = !!cleaned.error; } catch { intakeRetry = true; }
        // Editor dispatch has an independent minute worker so maintenance and
        // enrichment cannot prevent a due offer from being considered.
        try { await processJevInterruptionReviews({ limit: 1, timeBudgetMs: 20000 }); } catch { /* Keep the bot paused and retry independently of editor dispatch. */ }
        let sourceRetry = false;
        try { await processVeoSourceJobs(2, 25000); } catch { sourceRetry = true; }
        let budgetRetry = false;
        try { await refreshPageBudgets(); } catch { budgetRetry = true; }
        const processed = await processWorkspaceEvents(processFacebookWebhook, request.nextUrl.origin, Math.max(0, 210000 - (Date.now() - startedAt)));
        const autoApproved = await db.rpc('veo_auto_approve_pending_team_reviews', { p_limit: 20 });
        if (autoApproved.error) throw new Error('Team auto-approval queue unavailable');
        const approved = await db.rpc('veo_enqueue_approved_deal_reviews', { p_limit: 20 });
        if (approved.error) throw new Error('Approved receipt queue unavailable');
        const claimed = await db.rpc('veo_claim_submissions');
        if (claimed.error) throw new Error('Delivery queue unavailable');
        for (const s of claimed.data || []) {
            let status = 'queued', failure: string | null = null;
            try {
                // Facebook evidence was collected asynchronously before submission.
                // Delivery verifies the saved evidence without an interactive Graph read.
                if (Date.now() - startedAt > 240000) throw new Error('Delivery budget exhausted');
                const eligibility = await db.rpc('veo_handoff', { p_submission: s.id });
                if (eligibility.error) throw new Error('Eligibility read failed');
                if (!eligibility.data) {
                    // Missing or stale Facebook evidence is transient. Queue a source refresh
                    // and let the delivery lease retry; only durable business-rule blockers
                    // require the editor to review and resubmit.
                    const check = await db.rpc('veo_submission_requirements', { p_submission: s.id });
                    if (check.error) throw new Error('Eligibility read failed');
                    const blockers: string[] = check.data?.blockers || [];
                    const waitingForSource = blockers.includes('facebook_stage_unavailable') ||
                        (blockers.includes('facebook_matching_order_required') && !check.data?.source_conflict);
                    if (waitingForSource && check.data?.contact_id && check.data?.actor_id) {
                        const queued = await db.rpc('veo_request_source_refresh', { p_actor: check.data.actor_id, p_contact: check.data.contact_id });
                        if (queued.error) throw new Error('Source refresh unavailable');
                        failure = 'Facebook source refresh pending; delivery will retry automatically';
                    } else { status = 'blocked'; failure = 'Eligibility or page access changed; review and resubmit'; }
                }
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
        return NextResponse.json({ ok: true, processed, submissions: claimed.data?.length || 0, integration, receipt_deletion: receiptDeletion, budget_retry: budgetRetry, intake_retry: intakeRetry, source_retry: sourceRetry, operations_retry: !!operations.error, cleanup: operations.data || null });
    } catch (e: any) { return NextResponse.json({ ok: false, error: e.message }, { status: 503 }); }
}
