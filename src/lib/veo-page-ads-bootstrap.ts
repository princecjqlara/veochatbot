import { encryptMetaAdsToken } from './meta-ads-credentials';
import { inspectPageAdGrant, marketingConnection } from './facebook-ad-catalog';

/** Reuse only a current, assigned Page's verified read capability. Never replace
 * an existing ad credential, and coordinate failed discovery across workers. */
export async function bootstrapPageAds({ db, user, authorize }: { db: any; user: string; authorize: () => Promise<string[]> }) {
    const existing = await db.from('meta_ads_credentials').select('user_id').eq('user_id', user).maybeSingle();
    if (existing.error) throw Error('Advertising connection is unavailable');
    if (existing.data) return { connected: true, existing: true };
    const claim = await db.rpc('veo_claim_page_ads_discovery', { p_user: user });
    if (claim.error) throw Object.assign(Error('Saved Page advertising access could not be checked'), { status: claim.error.code === '42501' ? 403 : 503 });
    if (claim.data !== true) return { connected: false, skipped: true, reason: 'Saved Page advertising discovery is already running or will retry on the next hour.' };
    const error = 'Saved Page connections could not verify complete ad-account access. Connect Meta Ads to grant advertising read access.';
    try {
        const ids = await authorize();
        if (!ids.length) throw Error(error);
        const pages = await db.from('pages').select('id,fb_page_id,access_token').in('id', ids).eq('veo_enabled', true).order('id');
        if (pages.error || !Array.isArray(pages.data)) throw Error(error);
        const deadline = Date.now() + 45000;
        for (const page of pages.data) {
            if (Date.now() >= deadline) break;
            if (!page.access_token) continue;
            let grant, connection;
            try { grant = await inspectPageAdGrant(page.access_token, page.fb_page_id); connection = await marketingConnection(page.access_token); }
            catch { continue; }
            if (connection.status !== 'ready' || (connection as any).partial || !connection.accounts.length) continue;
            if (!(await authorize()).includes(page.id)) throw Error('Page access changed while checking advertising access');
            const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), from = new Date(Date.parse(today + 'T00:00:00Z') - 92 * 86400000).toISOString().slice(0, 10);
            const saved = await db.from('meta_ads_credentials').upsert({ user_id: user, ...encryptMetaAdsToken(page.access_token), credential_origin: 'connected_page', source_page_id: page.id,
                token_expires_at: grant.expires_at, permissions: grant.permissions, sync_checkpoint: { from, to: today, completed_windows: [], page_ids: [], account_ids: [] }, last_error: null, updated_at: new Date().toISOString()
            }, { onConflict: 'user_id', ignoreDuplicates: true });
            if (saved.error) throw Error('Verified advertising access could not be retained');
            const marked = await db.from('veo_ad_source_discovery').update({ status: 'connected', last_error: null }).eq('user_id', user);
            if (marked.error) throw Error('Advertising connection status could not be saved');
            return { connected: true, credential_origin: 'connected_page', accounts: connection.accounts.length };
        }
        throw Error(error);
    } catch (e) {
        await db.from('veo_ad_source_discovery').update({ status: 'failed', last_error: error }).eq('user_id', user);
        throw Object.assign(Error(e instanceof Error ? e.message : error), { status: 409 });
    }
}
