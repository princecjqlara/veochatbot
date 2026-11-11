import { encryptMetaAdsToken } from './meta-ads-credentials';
import { marketingConnection } from './facebook-ad-catalog';
import { PageSetupError } from './veo-page-connections';

/** Called only after the existing Owner-bound, one-use OAuth state is claimed.
 * This credential permits reads; no Meta advertising budget is written. */
export async function retainWorkspaceAdsGrant(db: any, owner: string, token: string, exchange: (token: string) => Promise<any>) {
    const connection = await marketingConnection(token);
    if (connection.status !== 'ready' || (connection as any).partial || !connection.accounts.length) throw new PageSetupError('Approve ad-account read access and select accessible advertising accounts.', 409, 'ADS_ACCESS_REQUIRED');
    const long = await exchange(token), seconds = Number(long.expires_in);
    if (typeof long.access_token !== 'string' || !long.access_token || long.access_token.length > 8192 || !Number.isFinite(seconds) || seconds <= 0 || seconds > 366 * 86400) throw new PageSetupError('Meta did not return a usable expiring ad-account credential. Connect again.', 409, 'ADS_AUTHORIZATION_FAILED');
    const saved = await db.from('meta_ads_credentials').upsert({ user_id: owner, ...encryptMetaAdsToken(long.access_token),
        token_expires_at: new Date(Date.now() + seconds * 1000).toISOString(), permissions: (connection as any).permissions || ['ads_read'],
        sync_checkpoint: null, last_error: null, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (saved.error) throw new PageSetupError('Ad-account access could not be retained. Retry connecting.', 503, 'ADS_AUTHORIZATION_FAILED');
}
