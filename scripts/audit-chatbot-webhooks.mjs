import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import pg from 'pg';
const { parse } = createRequire(new URL('../../package.json', import.meta.url))('dotenv');
const partner = parse(await readFile(new URL('../../tokkodev/.env.local', import.meta.url), 'utf8'));
const project = 'prj_nJDRdVj2Zm0WTLLo0xrNCHb5vsKB', team = 'team_6Ch2MHn0FBCPlVSDr5V9bsM6';
const auth = JSON.parse(await readFile(path.join(process.env.APPDATA, 'com.vercel.cli/Data/auth.json'), 'utf8'));
const envResponse = await fetch(`https://api.vercel.com/v10/projects/${project}/env?decrypt=true&teamId=${team}`, { headers: { Authorization: `Bearer ${auth.token}` } });
const envBody = await envResponse.json();
if (!envResponse.ok) throw new Error(envBody.error?.message || 'Production environment unavailable');
if (process.argv.includes('--inspect-env-keys')) {
    console.log(JSON.stringify({ variables: (envBody.envs || []).map(({ key, target, type }) => ({ key, target, type })), pagination: envBody.pagination }));
    process.exit(0);
}
const variables = (envBody.envs || []).filter(item => item.target?.includes('production'));
const env = {};
for (const item of variables.filter(item => ['FACEBOOK_CLIENT_ID','FACEBOOK_PARTNER_CHATBOT_PAGE_IDS'].includes(item.key))) {
    const response = await fetch(`https://api.vercel.com/v9/projects/${project}/env/${item.id}?decrypt=true&teamId=${team}`, { headers: { Authorization: `Bearer ${auth.token}` } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || 'Selected routing variable unavailable');
    env[item.key] = body.value;
}
const primary = env.FACEBOOK_CLIENT_ID;
if (!/^\d+$/.test(primary || '')) throw new Error('Primary app ID was not decrypted; refuse an inaccurate routing audit');
const callbacks = [];
for (const [id,secret,expectedPath] of [[primary,process.env.FACEBOOK_CLIENT_SECRET,'/api/facebook/webhook'],['1350694239880908',partner.FACEBOOK_APP_SECRET,'/api/facebook/partner-webhook']]) {
    const response = await fetch(`https://graph.facebook.com/v24.0/${id}/subscriptions`,{headers:{Authorization:`Bearer ${id}|${secret}`},signal:AbortSignal.timeout(10000)});
    const body = await response.json();
    if(!response.ok || body.error) throw new Error(body.error?.message || 'App callback read failed');
    const subscription = body.data?.find(item=>item.object==='page');
    if(!subscription?.active || subscription.callback_url!==`https://veochatbot.vercel.app${expectedPath}`) throw new Error(`App ${id} has an unexpected Page callback`);
    callbacks.push({app:id,active:subscription.active,url:subscription.callback_url});
}
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
try {
    const pages = (await db.query('SELECT p.id,p.name,p.fb_page_id,p.access_token,c.enabled FROM pages p JOIN chatbot_configs c ON c.page_id=p.id ORDER BY p.name')).rows;
    const rows = [];
    for (let offset = 0; offset < pages.length; offset += 3) {
        rows.push(...await Promise.all(pages.slice(offset,offset+3).map(async page => {
            try {
                const response = await fetch(`https://graph.facebook.com/v24.0/${page.fb_page_id}/subscribed_apps`, {
                    headers: { Authorization: `Bearer ${page.access_token}` }, signal: AbortSignal.timeout(10000) });
                const body = await response.json();
                if (!response.ok || body.error) throw new Error(body.error?.message || 'Subscription read failed');
                let apps = (body.data || []).map(app => ({ id: app.id, fields: app.subscribed_fields || [] }));
                if (process.argv.includes('--repair-fields') && apps.length === 1) {
                    const required = ['messages','messaging_postbacks','message_echoes'];
                    const previous = apps[0];
                    if (required.some(field => !previous.fields.includes(field))) {
                        await writeFile(new URL(`../../data/chatbot-subscription-backup-${page.id}-${Date.now()}.json`,import.meta.url),
                            JSON.stringify({ pageId:page.id,fbPageId:page.fb_page_id,apps },null,2),{flag:'wx'});
                        const fields = [...new Set([...previous.fields,...required])];
                        const saved = await fetch(`https://graph.facebook.com/v24.0/${page.fb_page_id}/subscribed_apps`, { method:'POST',
                            headers:{Authorization:`Bearer ${page.access_token}`},body:new URLSearchParams({subscribed_fields:fields.join(',')}),signal:AbortSignal.timeout(10000) });
                        const result = await saved.json();
                        if (!saved.ok || result.success !== true) throw new Error(result.error?.message || 'Subscription repair failed');
                        const verify = await fetch(`https://graph.facebook.com/v24.0/${page.fb_page_id}/subscribed_apps`,{headers:{Authorization:`Bearer ${page.access_token}`},signal:AbortSignal.timeout(10000)});
                        const readback = await verify.json();
                        apps = (readback.data || []).map(app => ({id:app.id,fields:app.subscribed_fields || []}));
                        if (!apps.some(app=>app.id===previous.id && fields.every(field=>app.fields.includes(field)))) throw new Error('Subscription repair did not persist');
                    }
                }
                let partnerRouted = false;
                if (apps.some(app => app.id !== primary)) {
                    // Sensitive production values cannot be read back. Probe
                    // actual routing with a signed entry containing NO events.
                    const payload = JSON.stringify({ object: 'page', entry: [{ id: page.fb_page_id, messaging: [] }] });
                    const probe = await fetch('https://veochatbot.vercel.app/api/facebook/partner-webhook', { method: 'POST', body: payload,
                        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', partner.FACEBOOK_APP_SECRET).update(payload).digest('hex') },
                        signal: AbortSignal.timeout(30000) });
                    const result = await probe.json();
                    if (!probe.ok) throw new Error(result.error || `Empty routing probe HTTP ${probe.status}`);
                    partnerRouted = result.chatbot_entries === 1;
                }
                return { pageId: page.id, name: page.name.trim(), fbPageId: page.fb_page_id, enabled: page.enabled,
                    partnerRouted, primarySubscribed: apps.some(app => app.id === primary), apps };
            } catch (error) { return { pageId: page.id, name: page.name.trim(), enabled: page.enabled, error: error.message }; }
        })));
    }
    const report = { at: new Date().toISOString(), primaryApp: primary, callbacks, partnerRoutedPageCount: rows.filter(row => row.partnerRouted).length, pages: rows, customerEventsSent: 0 };
    await writeFile(new URL('../../data/all-chatbot-webhook-audit.json', import.meta.url), JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
} finally { await db.end(); }
