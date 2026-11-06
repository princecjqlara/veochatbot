// Cache read-only Meta inventory/Insights. Never changes ad budgets, sends
// messages, imports conversations or creates financial payment records.
import fs from 'node:fs';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createClient } from '@supabase/supabase-js';
const option = name => process.argv.find(a => a.startsWith('--' + name + '='))?.slice(name.length + 3);
if (new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname !== 'vhtbmdizugnxkgocmruq.supabase.co') throw Error('Expected the maintained VEO database');
const from = option('from'), to = option('to') || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
if (!from) throw Error('Pass --from=YYYY-MM-DD for the first reporting date');
const owner = JSON.parse(fs.readFileSync('.vercel/workspace-launch-receipt.json', 'utf8')).owner;
await build({ stdin: { contents: "export {refreshMetaAdSpend} from './src/lib/meta-ads-sync'; export {decryptMetaAdsToken} from './src/lib/meta-ads-credentials';", resolveDir: process.cwd(), loader: 'ts' }, outfile: '.vercel/veo-ads-runtime.cjs', bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const { refreshMetaAdSpend, decryptMetaAdsToken } = createRequire(import.meta.url)('../.vercel/veo-ads-runtime.cjs');
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const scope = async () => { const r = await db.rpc('veo_scope', { p_actor: owner }); if (r.error || r.data?.role !== 'owner') throw Error('Retained Owner access is required'); return r.data; };
const s = await scope(), pages = await db.from('pages').select('id,fb_page_id').in('id', s.page_ids).eq('veo_enabled', true).eq('veo_tenant_id', s.tenant_id);
if (pages.error || pages.data.length !== s.page_ids.length) throw Error('Current VEO Pages could not be verified');
const credential = await db.from('meta_ads_credentials').select('*').eq('user_id', owner).single();
if (credential.error || !credential.data || credential.data.token_expires_at && Date.parse(credential.data.token_expires_at) <= Date.now()) throw Error('Stored Meta ad-account read credential is unavailable or expired');
const file = '.vercel/veo-ads-refresh-' + from + '-' + to + '.json';
const previous = option('resume') === 'true' && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const result = await refreshMetaAdSpend({ db, token: decryptMetaAdsToken(credential.data), pages: pages.data, from, to,
    authorize: async () => (await scope()).page_ids, completed: previous?.completed_windows || [], completedPages: previous?.page_ids, completedAccounts: previous?.account_ids,
    onProgress: report => { fs.writeFileSync(file, JSON.stringify({ ...report, no_messages_sent: true, no_budgets_changed: true }, null, 2)); console.log(JSON.stringify({ complete: report.complete, accounts: report.accounts, inventory_ads: report.inventory_ads, windows: report.completed_windows.length, spend_rows: report.saved_spend_rows, coverage_days: report.coverage_days, errors: report.errors })); } });
if (!result.complete) process.exitCode = 1;
