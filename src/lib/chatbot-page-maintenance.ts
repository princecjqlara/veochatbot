const REQUIRED_FIELDS = ['messages', 'messaging_postbacks', 'message_echoes'];

async function graph(path: string, token: string, body?: URLSearchParams): Promise<any> {
    const response = await fetch(`https://graph.facebook.com/v21.0/${path}`, {
        method: body ? 'POST' : 'GET', cache: 'no-store',
        headers: { Authorization: `Bearer ${token}` },
        ...(body ? { body } : {}), signal: AbortSignal.timeout(5000)
    });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error?.message || `Webhook subscription check HTTP ${response.status}`);
    return result;
}

/** Restore echoes removed by other app clients, without subscribing the wrong app. */
export async function ensureChatbotPageWebhook(input: { facebookPageId: string; accessToken: string }) {
    const primaryApp = process.env.FACEBOOK_CLIENT_ID;
    const partnerPage = (process.env.FACEBOOK_PARTNER_CHATBOT_PAGE_IDS || '').split(',').map(id => id.trim()).includes(input.facebookPageId);
    const subscriptions = await graph(`${encodeURIComponent(input.facebookPageId)}/subscribed_apps`, input.accessToken);
    if (!Array.isArray(subscriptions.data)) throw new Error('Page webhook subscriptions are unavailable');
    const candidates = subscriptions.data.filter((app: { id?: string }) => partnerPage ? app.id !== primaryApp : app.id === primaryApp);
    if (candidates.length !== 1 || typeof candidates[0].id !== 'string') throw new Error('Expected one existing chatbot app subscription');
    const app = candidates[0];
    const existing: string[] = Array.isArray(app.subscribed_fields) ? app.subscribed_fields : [];
    const missing = REQUIRED_FIELDS.filter(field => !existing.includes(field));
    if (!missing.length) return { verified: true, repaired: false };
    const secret = partnerPage ? process.env.FACEBOOK_PARTNER_APP_SECRET : process.env.FACEBOOK_CLIENT_SECRET;
    if (!secret) throw new Error('App credentials are unavailable for webhook subscription repair');
    const debug = await graph(`debug_token?input_token=${encodeURIComponent(input.accessToken)}`, `${app.id}|${secret}`);
    if (!debug.data?.is_valid || debug.data.app_id !== app.id) throw new Error('Page token does not belong to the existing chatbot app');
    const fields = [...new Set([...existing, ...REQUIRED_FIELDS])];
    const updated = await graph(`${encodeURIComponent(input.facebookPageId)}/subscribed_apps`, input.accessToken,
        new URLSearchParams({ subscribed_fields: fields.join(',') }));
    if (updated.success !== true) throw new Error('Page webhook subscription repair was not confirmed');
    const verified = await graph(`${encodeURIComponent(input.facebookPageId)}/subscribed_apps`, input.accessToken);
    const saved = verified.data?.find((item: { id?: string }) => item.id === app.id)?.subscribed_fields || [];
    if (!fields.every(field => saved.includes(field))) throw new Error('Page webhook subscription repair did not persist');
    return { verified: true, repaired: true };
}

/** Retry tags from saved stages, even after the original history checkpoint has passed. */
export async function repairSavedMessengerOutcomeTags(db: { rpc: (name: string, args: any) => any }, pageId: string) {
    const { data, error } = await db.rpc('repair_chatbot_page_outcome_tags', { p_page_id: pageId, p_limit: 250 });
    if (error) throw new Error(error.message || 'Could not repair saved Messenger outcome tags');
    return Number(data) || 0;
}
