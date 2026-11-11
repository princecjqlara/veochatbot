import { encryptMetaAdsToken } from './meta-ads-credentials';
import { marketingConnection } from './facebook-ad-catalog';
import { PageSetupError } from './veo-page-connections';

/** Called only after the existing Owner-bound, one-use OAuth state is claimed.
 * This credential permits reads; no Meta advertising budget is written. */
export async function retainWorkspaceAdsGrant(db: any, owner: string, token: string, exchange: (token: string) => Promise<any>, inspect?: (token: string) => Promise<any>) {
    const connection = await marketingConnection(token);
    if (connection.status === 'temporarily_unavailable') throw new PageSetupError('Meta ad-account verification is temporarily unavailable. Retry the saved authorization.', 503, 'ADS_VERIFICATION_UNAVAILABLE');
    if (connection.status !== 'ready' || (connection as any).partial || !connection.accounts.length) throw new PageSetupError('Approve ad-account read access and select accessible advertising accounts.', 409, 'ADS_ACCESS_REQUIRED');
    let long: any;
    try { long = await exchange(token); }
    catch { throw new PageSetupError('Meta could not extend advertising access. Retry the saved authorization.', 503, 'ADS_TOKEN_EXCHANGE_FAILED'); }
    if (typeof long.access_token !== 'string' || !long.access_token || long.access_token.length > 8192) throw new PageSetupError('Meta did not return a usable advertising credential. Retry the saved authorization.', 409, 'ADS_TOKEN_EXCHANGE_FAILED');
    const seconds = Number(long.expires_in ?? long.expires);
    let expiresAt = Number.isFinite(seconds) && seconds > 0 && seconds <= 366 * 86400 ? Date.now() + seconds * 1000 : null;
    if (inspect) {
        let metadata: any;
        try { metadata = (await inspect(long.access_token))?.data; }
        catch { throw new PageSetupError('Meta token verification is temporarily unavailable. Retry the saved authorization.', 503, 'ADS_VERIFICATION_UNAVAILABLE'); }
        if (metadata?.is_valid !== true || String(metadata.app_id) !== process.env.FACEBOOK_CLIENT_ID || !['USER','SYSTEM_USER'].includes(metadata.type)) throw new PageSetupError('The advertising authorization is invalid or belongs to another app. Connect Meta Ads again.', 409, 'ADS_TOKEN_INVALID');
        const expiry = Number(metadata.expires_at), dataExpiry = Number(metadata.data_access_expires_at);
        const limits = [expiry, dataExpiry].filter(v => Number.isFinite(v) && v > 0).map(v => v * 1000);
        if (limits.length) expiresAt = Math.min(...limits, ...(expiresAt ? [expiresAt] : []));
        else if (metadata.type === 'SYSTEM_USER' && expiry === 0) expiresAt = null;
        else if (!expiresAt) throw new PageSetupError('Meta did not provide a verifiable token expiry. Retry the saved authorization.', 409, 'ADS_TOKEN_EXPIRY_UNAVAILABLE');
    }
    if (expiresAt !== null && expiresAt <= Date.now() + 60000 || expiresAt === null && !inspect) throw new PageSetupError('The advertising credential is expired or its expiry could not be verified. Connect Meta Ads again.', 409, 'ADS_TOKEN_EXPIRY_UNAVAILABLE');
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), from = new Date(Date.parse(today + 'T00:00:00Z') - 14 * 86400000).toISOString().slice(0, 10);
    const saved = await db.from('meta_ads_credentials').upsert({ user_id: owner, ...encryptMetaAdsToken(long.access_token),
        token_expires_at: expiresAt === null ? null : new Date(expiresAt).toISOString(), permissions: (connection as any).permissions || ['ads_read'],
        sync_checkpoint: { from, to: today, completed_windows: [], page_ids: [], account_ids: [] }, last_error: null, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (saved.error) throw new PageSetupError('Advertising access could not be saved. Retry the saved authorization.', 503, 'ADS_CREDENTIAL_SAVE_FAILED');
}
