import { getSupabaseAdmin } from '@/lib/supabase';
import { fetchBusinessOrderNotices } from '@/lib/veo-business-orders';
import { syncMessengerStageHistory } from '@/lib/messenger-stage-sync';

/** Small cron batch: Graph reads never hold up an interactive workspace request. */
export async function processVeoSourceJobs(limit = 2, timeBudgetMs = 25000) {
    const db = getSupabaseAdmin(), started = Date.now();
    const claim = await db.rpc('veo_claim_source_jobs', { p_limit: Math.min(2, Math.max(1, limit)) });
    if (claim.error) throw new Error('Facebook source queue unavailable');
    let completed = 0, retried = 0;
    for (const job of claim.data || []) {
        let scan: any = { error: 'Facebook source refresh failed' };
        try {
            if (Date.now() - started > timeBudgetMs) throw Error('Source refresh budget exhausted');
            const [page, contact, tenant] = await Promise.all([
                db.from('pages').select('fb_page_id,access_token').eq('id', job.page_id).single(),
                db.from('contacts').select('id,page_id,psid').eq('id', job.contact_id).single(),
                db.from('veo_tenants').select('owner_id,launch_at').eq('id', job.tenant_id).single()
            ]);
            if (page.error || contact.error || tenant.error || contact.data?.page_id !== job.page_id || !page.data?.access_token || !contact.data?.psid || !tenant.data?.launch_at) throw Error('Page connection or client conversation unavailable');
            scan = await fetchBusinessOrderNotices({ pageId: page.data.fb_page_id, psid: contact.data.psid, token: page.data.access_token, launchAt: tenant.data.launch_at, cursorUrl: job.cursor_url, timeoutMs: Math.min(18000, timeBudgetMs - (Date.now() - started)) });
            const observed = await db.rpc('veo_observe_business_orders', { p_actor: tenant.data.owner_id, p_contact: job.contact_id, p_orders: scan.orders });
            if (observed.error) throw Error('Could not save Facebook order observations');
            const stages = await syncMessengerStageHistory(db, { pageId: job.page_id, contactId: job.contact_id, facebookPageId: page.data.fb_page_id, messages: scan.messages });
            const reconciled = await db.rpc('veo_reconcile_contact_order', { p_actor: tenant.data.owner_id, p_contact: job.contact_id });
            if (reconciled.error) throw Error('Could not reconcile observed client order');
            scan = { complete: scan.complete, next_cursor: scan.next_cursor, stages_saved: stages.events, orders_seen: scan.orders.length, coverage: scan.coverage };
        } catch (error: any) {
            scan = { complete: false, error: error.message || 'Facebook source refresh failed' };
            retried++;
        }
        const finished = await db.rpc('veo_finish_source_job', { p_contact: job.contact_id, p_claim: job.claim_token, p_scan: scan });
        if (finished.error || !finished.data) throw new Error('Facebook source refresh lease lost');
        completed++;
    }
    return { claimed: claim.data?.length || 0, completed, retried };
}
