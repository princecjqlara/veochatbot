import { DatabaseReadTimeout, requestDeadline } from './request-deadline';
import { isFacebookReauthMessage } from './facebook-errors';
import { FACEBOOK_PAGE_WEBHOOK_FIELDS } from './facebook-permissions';

export class FacebookPageConnectionError extends Error {
 constructor(message: string, readonly code: string, readonly status: number, readonly requiresReauth = false, readonly retryable = false) { super(message); }
}

/** Verify the supplied Page credential before replacing any stored token. */
export async function verifyFacebookPageConnection(pageId: string, accessToken: string) {
 const read = async (endpoint: string, fields: Record<string, string>) => {
  try {
   return await requestDeadline(async signal => {
    const url = new URL('https://graph.facebook.com/v21.0/' + endpoint);
    for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
    const response = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken }, cache: 'no-store', signal });
    const body = await response.json();
    if (!response.ok || body.error) {
     const reauth = [10, 190, 200].includes(Number(body.error?.code)) || isFacebookReauthMessage(String(body.error?.message || ''));
     throw new FacebookPageConnectionError(reauth
      ? 'Facebook needs renewed Page permissions. Use Refresh Permissions with an account that can manage this Page and approve messaging access.'
      : 'Facebook could not verify this Page. Please retry.', reauth ? 'FACEBOOK_REAUTH_REQUIRED' : 'FACEBOOK_UNAVAILABLE', reauth ? 409 : 503, reauth, !reauth);
    }
    return body;
   }, 8000);
  } catch (error) {
   if (error instanceof FacebookPageConnectionError) throw error;
   throw new FacebookPageConnectionError(error instanceof DatabaseReadTimeout ? 'Facebook verification timed out. Please retry Connect.' : 'Facebook verification is temporarily unavailable. Please retry Connect.', 'FACEBOOK_UNAVAILABLE', 503, false, true);
  }
 };
 const identity = await read('me', { fields: 'id,name' });
 if (identity.id !== pageId) throw new FacebookPageConnectionError('The Page credential belongs to a different account or Page. Refresh Permissions and choose this Page again.', 'FACEBOOK_PAGE_TOKEN_MISMATCH', 409, true);
 const inbox = await read(pageId + '/conversations', { fields: 'id', limit: '1' });
 if (!Array.isArray(inbox.data)) throw new FacebookPageConnectionError('Facebook did not confirm access to this Page inbox. Please retry.', 'FACEBOOK_UNAVAILABLE', 503, false, true);
 return { id: identity.id as string, name: typeof identity.name === 'string' ? identity.name : null };
}

/** A saved token alone does not prove that the app receives Page updates. */
export async function facebookWebhookConnectionStatus(pageId: string, accessToken: string, appId?: string): Promise<'ready' | 'incomplete' | 'unknown'> {
 if (!appId) return 'unknown';
 try {
  return await requestDeadline(async signal => {
   const response = await fetch('https://graph.facebook.com/v21.0/' + pageId + '/subscribed_apps?fields=id,subscribed_fields', {
    headers: { Authorization: 'Bearer ' + accessToken }, cache: 'no-store', signal
   });
   const body = await response.json();
   if (!response.ok || body.error) return [10, 190, 200].includes(Number(body.error?.code)) ? 'incomplete' : 'unknown';
   if (!Array.isArray(body.data)) return 'unknown';
   const app = body.data.find((app: { id: string }) => app.id === appId);
   if (!app) return 'incomplete';
   if (!Array.isArray(app.subscribed_fields)) return 'unknown';
   return FACEBOOK_PAGE_WEBHOOK_FIELDS.every(field => app.subscribed_fields.includes(field)) ? 'ready' : 'incomplete';
  }, 2000);
 } catch { return 'unknown'; }
}
