import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { decryptMetaAdsToken } from '@/lib/meta-ads-credentials';
import { catalogMetadata, creativePageId, marketingConnection, MetaAdAccessError, readMetaAds } from '@/lib/facebook-ad-catalog';
import { alignedWithPht, DAILY_INSIGHT_FIELDS, dailyDeliveryMetrics, normalizeDailySpend } from '@/lib/ad-daily-spend';
import { phtDate } from '@/lib/conversion-performance';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;
const DAY = 86_400_000, WORK_BUDGET = 245_000;
const safeError = (e: unknown) => e instanceof MetaAdAccessError ? `Meta API error ${e.code}` : e instanceof Error ? e.message.slice(0, 300) : 'Scheduled Meta Ads sync failed';

export async function GET(request: NextRequest) {
 if (!process.env.CRON_SECRET) return NextResponse.json({ error: 'Scheduler is not configured' }, { status: 503 });
 if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
 const db = getSupabaseAdmin(), started = Date.now(), report = { credentials: 0, accounts: 0, ads_read: 0, spend_rows_saved: 0, inventory_ads_saved: 0, errors: [] as Array<{ user_id: string; error: string }> };
 const credentials = await db.from('meta_ads_credentials').select('user_id,token_ciphertext,token_iv,token_auth_tag,token_expires_at').limit(100);
 if (credentials.error) return NextResponse.json({ error: 'Could not read scheduled Meta credentials; apply the ads-sync migration.' }, { status: 503 });
 for (const credential of credentials.data || []) {
  report.credentials++;
  try {
   if (credential.token_expires_at && Date.parse(credential.token_expires_at) <= Date.now()) throw Error('Stored Facebook token expired; reconnect ad access.');
   const token = decryptMetaAdsToken(credential), connection = await marketingConnection(token);
   if (connection.status !== 'ready') throw Error(connection.message || 'Facebook ad-account permission is unavailable.');
   if (!connection.accounts.length) throw Error('No accessible ad accounts for this Facebook login.');
   const memberships = await db.from('user_pages').select('page_id').eq('user_id', credential.user_id);
   if (memberships.error) throw Error('Could not load authorized Pages.');
   const pageIds = [...new Set((memberships.data || []).map((row: any) => row.page_id))];
   if (!pageIds.length) throw Error('No Pages are assigned to this user.');
   const pagesResult = await db.from('pages').select('id,fb_page_id').in('id', pageIds);
   if (pagesResult.error) throw Error('Could not load authorized Facebook Pages.');
   const pages = new Map((pagesResult.data || []).filter((page: any) => page.fb_page_id).map((page: any) => [page.fb_page_id, page.id]));
   if (!pages.size) throw Error('No authorized Facebook Page IDs are available.');
   for (const account of connection.accounts) {
    if (Date.now() - started > WORK_BUDGET) break;
    report.accounts++;
    const accountKey = account.id.slice(4), stateResult = await db.from('meta_ads_sync_state').select('next_window_start,last_inventory_at').eq('user_id', credential.user_id).eq('account_id', accountKey).maybeSingle();
    if (stateResult.error) throw Error('Could not read ad sync progress.');
    let state: { next_window_start: string | null; last_inventory_at: string | null } | null = stateResult.data;
    const refreshInventory = !state?.last_inventory_at || Date.now() - Date.parse(state.last_inventory_at) > 12 * 60 * 60 * 1000;
    let allowed = new Map<string, string>();
    if (refreshInventory) {
     let after: string | undefined, inventoryComplete = false, pagesRead = 0;
     while (!inventoryComplete && pagesRead++ < 100 && Date.now() - started < WORK_BUDGET) {
      const result = await readMetaAds(account.id + '/ads', token, { fields: 'id,name,account_id,effective_status,campaign{id,name},adset{id,name},creative{id,name,thumbnail_url,effective_object_story_id,object_story_id,object_story_spec}', limit: '100', ...(after ? { after } : {}) });
      if (!Array.isArray(result.data)) throw Error('Facebook returned an incomplete ad inventory.');
      const records = (result.data || []).flatMap((ad: any) => { const fbPage = creativePageId(ad), pageId = fbPage && pages.get(fbPage); return pageId ? [catalogMetadata(ad, pageId)] : []; });
      if (records.length) { const saved = await db.rpc('save_ad_catalog_metadata', { p_records: records }); if (saved.error) throw Error('Could not save verified ad inventory.'); report.inventory_ads_saved += records.length; }
      if (!result.paging?.next) inventoryComplete = true;
      else { after = result.paging.cursors?.after; if (!after) throw Error('Facebook omitted the ad inventory continuation cursor.'); }
     }
     if (!inventoryComplete) continue;
     const marked = await db.from('meta_ads_sync_state').upsert({ user_id: credential.user_id, account_id: accountKey, last_inventory_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: 'user_id,account_id' });
     if (marked.error) throw Error('Could not save inventory sync time.');
     state = { next_window_start: state?.next_window_start ?? null, last_inventory_at: new Date().toISOString() };
    }
    const catalogRows: any[] = [];
    for (let offset = 0; offset < 50_000; offset += 1000) {
     const catalog = await db.from('ad_source_catalog').select('page_id,ad_id').in('page_id', pageIds).eq('ad_account_id', accountKey).order('page_id').order('ad_id').range(offset, offset + 999);
     if (catalog.error) throw Error('Could not load Page-verified ad IDs.');
     catalogRows.push(...(catalog.data || [])); if ((catalog.data || []).length < 1000) break;
    }
    allowed = new Map(catalogRows.map((ad: any) => [ad.ad_id, ad.page_id]));
    if (!allowed.size) continue;
    const metaAccount = await readMetaAds(account.id, token, { fields: 'id,currency,timezone_name' });
    if (metaAccount.id !== account.id || !/^[A-Z]{3}$/.test(metaAccount.currency || '') || typeof metaAccount.timezone_name !== 'string') throw Error('Facebook did not verify the ad-account currency and timezone.');
    const today = phtDate(Date.now()), earliest = phtDate(Date.now() - 30 * DAY);
    let start = state?.next_window_start && state.next_window_start >= earliest && state.next_window_start <= today ? state.next_window_start : earliest;
    const end = new Date(Math.min(Date.parse(start + 'T00:00:00Z') + 6 * DAY, Date.parse(today + 'T00:00:00Z'))).toISOString().slice(0, 10);
    const rows = new Map<string, any>(), seen = new Set<string>(); let after: string | undefined, complete = false;
    for (let page = 0; page < 100 && Date.now() - started < WORK_BUDGET; page++) {
     const result = await readMetaAds(account.id + '/insights', token, { fields: DAILY_INSIGHT_FIELDS, level: 'ad', time_increment: '1', action_report_time: 'conversion', use_unified_attribution_setting: 'true', time_range: JSON.stringify({ since: start, until: end }), limit: '500', ...(after ? { after } : {}) });
     if (!Array.isArray(result.data)) throw Error('Facebook returned an incomplete Insights report.');
     for (const source of result.data) {
      if (!allowed.has(source.ad_id)) continue;
      const value = normalizeDailySpend(source, metaAccount, allowed, start, end);
      if (!value) continue;
      const key = `${value.ad_id}:${value.spend_date}`; if (rows.has(key)) throw Error('Facebook returned duplicate daily ad rows.');
      rows.set(key, { ...value, ...dailyDeliveryMetrics(source), report_complete: true, reported_zero: false });
     }
     if (!result.paging?.next) { complete = true; break; }
     after = result.paging.cursors?.after; if (!after || seen.has(after)) throw Error('Facebook omitted or repeated an Insights cursor.'); seen.add(after);
    }
    if (!complete) continue;
    for (let ms = Date.parse(start + 'T00:00:00Z'); ms <= Date.parse(end + 'T00:00:00Z'); ms += DAY) {
     const day = new Date(ms).toISOString().slice(0, 10);
     for (const [adId, pageId] of allowed) if (!rows.has(`${adId}:${day}`)) rows.set(`${adId}:${day}`, { page_id: pageId, ad_id: adId, account_id: accountKey, spend_date: day, currency: metaAccount.currency, account_timezone: metaAccount.timezone_name, pht_aligned: alignedWithPht(day, metaAccount.timezone_name), amount: 0, impressions: 0, clicks: 0, reach: 0, link_clicks: 0, messaging_started: 0, video_plays: 0, video_thruplays: 0, video_complete: 0, action_report_time: 'conversion', attribution_setting: 'adset_unified', report_complete: true, reported_zero: true, checked_at: new Date().toISOString() });
    }
    for (let offset = 0; offset < rows.size; offset += 500) { const result = await db.from('ad_daily_spend').upsert([...rows.values()].slice(offset, offset + 500), { onConflict: 'page_id,ad_id,spend_date,account_id' }); if (result.error) throw Error('Could not save completed daily ad spend.'); }
    report.spend_rows_saved += rows.size; report.ads_read++;
    const nextStart = Date.parse(end + 'T00:00:00Z') >= Date.parse(today + 'T00:00:00Z') ? earliest : new Date(Date.parse(end + 'T00:00:00Z') + DAY).toISOString().slice(0, 10);
    const progress = await db.from('meta_ads_sync_state').upsert({ user_id: credential.user_id, account_id: accountKey, next_window_start: nextStart, updated_at: new Date().toISOString() }, { onConflict: 'user_id,account_id' });
    if (progress.error) throw Error('Could not save spend sync progress.');
   }
   await db.from('meta_ads_credentials').update({ last_synced_at: new Date().toISOString(), last_error: null }).eq('user_id', credential.user_id);
  } catch (error) {
   report.errors.push({ user_id: credential.user_id, error: safeError(error) });
   await db.from('meta_ads_credentials').update({ last_error: safeError(error), updated_at: new Date().toISOString() }).eq('user_id', credential.user_id);
  }
 }
 return NextResponse.json({ ...report, complete: report.errors.length === 0, finished_at: new Date().toISOString() }, { status: report.errors.length ? 503 : 200, headers: { 'Cache-Control': 'no-store' } });
}
