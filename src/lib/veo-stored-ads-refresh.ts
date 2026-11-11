import { randomUUID } from 'node:crypto';
import { decryptMetaAdsToken } from './meta-ads-credentials';
import { refreshMetaAdSpend } from './meta-ads-sync';

export async function refreshStoredWorkspaceAds({ db, user, from, to, authorize, deadline = Date.now() + 245000, workspaceOnly = true }: {
    db: any; user: string; from: string; to: string; authorize: () => Promise<string[]>; deadline?: number; workspaceOnly?: boolean;
}) {
    const loaded = await db.from('meta_ads_credentials').select('token_ciphertext,token_iv,token_auth_tag,token_expires_at,sync_checkpoint').eq('user_id', user).maybeSingle();
    if (loaded.error) throw Error('Saved advertising access is temporarily unavailable');
    const credential = loaded.data;
    if (!credential || credential.token_expires_at && Date.parse(credential.token_expires_at) <= Date.now()) throw Object.assign(Error('Connect Meta Ads with ad-account read access first.'), { status: 409, requiresReconnect: true });
    let token: string; try { token = decryptMetaAdsToken(credential); } catch { throw Object.assign(Error('Reconnect Meta Ads to renew the saved advertising credential.'), { status: 409, requiresReconnect: true }); }
    const ids = await authorize(); if (!ids.length) throw Object.assign(Error('No authorized Pages are available for advertising reports.'), { status: 403 });
    let pageQuery = db.from('pages').select('id,fb_page_id').in('id', ids); if (workspaceOnly) pageQuery = pageQuery.eq('veo_enabled', true);
    const pages = await pageQuery;
    if (pages.error || !pages.data?.length) throw Error('Authorized advertising Pages could not be verified');
    const lease = randomUUID(), claim = await db.rpc('veo_claim_meta_ads_refresh', { p_user: user, p_token: lease });
    if (claim.error) throw Error('Advertising refresh is temporarily unavailable');
    if (!claim.data) throw Object.assign(Error('An advertising refresh is already running. Wait for it to finish, then recheck.'), { status: 409 });
    try {
        const checkpoint = credential.sync_checkpoint?.from === from && credential.sync_checkpoint?.to === to ? credential.sync_checkpoint : null;
        const result = await refreshMetaAdSpend({ db, token, pages: pages.data, from, to, deadline, authorize,
            completed: checkpoint?.completed_windows, completedPages: checkpoint?.page_ids, completedAccounts: checkpoint?.account_ids });
        const saved = await db.from('meta_ads_credentials').update({
            ...(result.complete ? { last_synced_at: new Date().toISOString() } : {}), last_error: result.errors.join('; ').slice(0, 300) || null,
            sync_checkpoint: result.complete ? null : { from, to, completed_windows: result.completed_windows, page_ids: result.page_ids, account_ids: result.account_ids },
            updated_at: new Date().toISOString(), refresh_lease_token: null, refresh_lease_until: null
        }).eq('user_id', user).eq('refresh_lease_token', lease);
        if (saved.error) throw Error('Advertising results were fetched but refresh progress could not be saved. Recheck before retrying.');
        return result;
    } finally {
        await db.from('meta_ads_credentials').update({ refresh_lease_token: null, refresh_lease_until: null }).eq('user_id', user).eq('refresh_lease_token', lease);
    }
}
