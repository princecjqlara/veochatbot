import { createClient } from '@supabase/supabase-js';

// Preserve existing subscriptions; add page-authored echoes used for handoffs.
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const appId = process.env.FACEBOOK_CLIENT_ID;
if (!appId) throw new Error('FACEBOOK_CLIENT_ID is required');
const { data: configs, error } = await db.from('chatbot_configs').select('page_id').eq('enabled', true);
if (error) throw new Error(error.message);
const apply = process.argv.includes('--apply');
for (const config of configs || []) {
    const { data: page, error: pageError } = await db.from('pages')
        .select('name,fb_page_id,access_token').eq('id', config.page_id).single();
    if (pageError) throw new Error(pageError.message);
    const url = `https://graph.facebook.com/v21.0/${page.fb_page_id}/subscribed_apps`;
    const headers = { Authorization: `Bearer ${page.access_token}` };
    const read = async () => {
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
        const body = await response.json();
        if (!response.ok || body.error) throw new Error(body.error?.message || 'Could not read Page subscriptions');
        return body.data?.find(app => app.id === appId)?.subscribed_fields || [];
    };
    const existing = await read();
    const fields = [...new Set([...existing, 'messages', 'messaging_postbacks', 'message_echoes'])];
    if (apply && fields.some(field => !existing.includes(field))) {
        const response = await fetch(url, {
            method: 'POST', headers,
            body: new URLSearchParams({ subscribed_fields: fields.join(',') }),
            signal: AbortSignal.timeout(15000)
        });
        const body = await response.json();
        if (!response.ok || !body.success) throw new Error(body.error?.message || 'Page did not confirm subscriptions');
    }
    const verified = apply ? await read() : existing;
    if (apply && fields.some(field => !verified.includes(field))) throw new Error('Page subscriptions did not persist');
    console.log(JSON.stringify({ page: page.name, applied: apply, fields: verified, missing: fields.filter(field => !verified.includes(field)) }));
}
