import { getSupabaseAdmin } from './supabase';
import { getUserPageIds } from './page-access';
import { refreshStoredWorkspaceAds } from './veo-stored-ads-refresh';
import { workspaceEnabled } from './veo-workspace';

/** Shared by the existing external cron route and the authenticated ads worker.
 * PostgreSQL claims enforce the hour across processes, routes and retries. */
export async function runScheduledMetaAds(db: any = getSupabaseAdmin()) {
    const deadline = Date.now() + 245000;
    const credentials = await db.from('meta_ads_credentials').select('user_id,token_expires_at,sync_checkpoint').limit(100);
    if (credentials.error) return { complete: false, errors: ['Scheduled Meta credentials are unavailable'], reports: [] };
    if (!credentials.data?.length) return { complete: false, skipped: true, reason: 'connect_meta_ads_required', reports: [] };
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0,10), from = new Date(Date.parse(today+'T00:00:00Z')-3*86400000).toISOString().slice(0,10);
    const reports: any[] = [];
    for (const credential of credentials.data) {
        let claimed = false;
        try {
            if (Date.now() >= deadline) throw Error('Scheduled ad refresh deadline reached');
            if (credential.token_expires_at && Date.parse(credential.token_expires_at) <= Date.now()) throw Error('Stored Meta ad credential has expired');
            const claim = await db.rpc('veo_claim_scheduled_meta_ads_refresh', { p_user: credential.user_id });
            if (claim.error) throw Error('Hourly advertising coordination is unavailable');
            if (claim.data !== true) { reports.push({ user_id: credential.user_id, complete: true, skipped: true, reason: 'Hourly refresh is not due or a refresh is running' });continue; }
            claimed = true;
            const checkpoint = credential.sync_checkpoint;
            const validDay = (v: unknown): v is string => typeof v === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
            const resume = checkpoint && validDay(checkpoint.from) && validDay(checkpoint.to) && checkpoint.from<=checkpoint.to && checkpoint.to<=today && Date.parse(checkpoint.to)-Date.parse(checkpoint.from)<=92*86400000;
            const result = await refreshStoredWorkspaceAds({ db, user: credential.user_id, from: resume?checkpoint.from:from, to: resume?checkpoint.to:today, deadline, workspaceOnly: workspaceEnabled(), preserveOtherCheckpoint: true,
                authorize: () => getUserPageIds(credential.user_id) });
            reports.push({ user_id: credential.user_id, ...result });
            const saved = await db.from('meta_ads_credentials').update({ scheduled_refresh_finished_at:new Date().toISOString(),scheduled_refresh_status:result.complete?'complete':'incomplete' }).eq('user_id',credential.user_id);
            if (saved.error) throw Error('Scheduled advertising status could not be saved');
        } catch(error) {
            const busy = (error as any)?.status===409 && !(error as any)?.requiresReconnect;
            const message = error instanceof Error?error.message.slice(0,300):'Scheduled Meta Ads sync failed';
            reports.push({ user_id:credential.user_id,complete:busy,...(busy?{skipped:true,reason:'Refresh already running'}:{errors:[message]}) });
            const saved = await db.from('meta_ads_credentials').update({ ...(!busy?{last_error:message}:{}),...(claimed?{scheduled_refresh_finished_at:new Date().toISOString(),scheduled_refresh_status:busy?'skipped':'failed'}:{}),updated_at:new Date().toISOString() }).eq('user_id',credential.user_id);
            if (saved.error) console.warn('[META_ADS_SCHEDULE] Status save needs retry');
        }
    }
    return {complete:reports.length>0&&reports.every(r=>r.complete),reports,finished_at:new Date().toISOString()};
}
