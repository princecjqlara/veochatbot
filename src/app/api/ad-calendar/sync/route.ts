import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getUserPageIds } from '@/lib/page-access';
import { getSupabaseAdmin } from '@/lib/supabase';
import { readMetaAds, MetaAdAccessError } from '@/lib/facebook-ad-catalog';
import { adQualityRange } from '@/lib/ad-quality-range';
import { phtDate } from '@/lib/conversion-performance';
import { alignedWithPht, DAILY_INSIGHT_FIELDS, dailyDeliveryMetrics, normalizeDailySpend } from '@/lib/ad-daily-spend';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
 const session = await getSessionFromRequest(request);
 if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
 if (request.headers.get('origin') !== request.nextUrl.origin) return NextResponse.json({ error: 'Same-origin request required' }, { status: 403 });
 let body: any, from: string, to: string;
 try {
  body = await request.json();
  if (!/^act_\d{1,100}$/.test(body?.accountId || '') || !Array.isArray(body.adIds) || body.adIds.length < 1 || body.adIds.length > 20 || !body.adIds.every((id: unknown) => typeof id === 'string' && /^\d{1,100}$/.test(id))) throw Error('Choose up to 20 recorded ads');
  const range = adQualityRange(new URLSearchParams({ range: 'custom', from: body.from || '', to: body.to || '' }));
  from = phtDate(Date.parse(range.from!)); to = phtDate(Date.parse(range.to) - 1);
  if (Date.parse(to) - Date.parse(from) > 6 * 86400000) throw Error('Refresh at most seven reporting dates per batch');
 } catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 400 }); }
 const memberships = await getUserPageIds(session.user.id);
 if (body.pageId && !memberships.includes(body.pageId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
 if (!session.accessToken) return NextResponse.json({ error: 'Connect Facebook ad-account read access before importing actual spend.', requiresReconnect: true }, { status: 409 });
 try {
  const db = getSupabaseAdmin(), pages = body.pageId ? [body.pageId] : memberships;
  const catalog = await db.rpc('get_visible_ad_catalog', { p_page_ids: pages, p_from: null, p_to: new Date().toISOString() });
  if (catalog.error) throw Error('Could not verify ad ownership');
  const allowed = new Map<string, string>();
  for (const ad of (catalog.data || []).filter((ad: any) => pages.includes(ad.page_id) && ad.ad_account_id === body.accountId.slice(4) && body.adIds.includes(ad.ad_id))) {
   if (allowed.has(ad.ad_id) && allowed.get(ad.ad_id) !== ad.page_id) return NextResponse.json({ error: 'This ad has conflicting Page ownership records. Select one Page before importing spend.' }, { status: 409 });
   allowed.set(ad.ad_id, ad.page_id);
  }
  const ids = [...new Set<string>(body.adIds)];
  if (ids.some(id => !allowed.has(id))) return NextResponse.json({ error: 'One or more ads do not belong to the authorized Pages and ad account' }, { status: 403 });
  const account = await readMetaAds(body.accountId, session.accessToken, { fields: 'id,currency,timezone_name' });
  if (account.id !== body.accountId || !/^[A-Z]{3}$/.test(account.currency || '') || typeof account.timezone_name !== 'string') throw Error('Ad-account currency or timezone could not be verified');
  const records = new Map<string, any>(), seen = new Set<string>(), today = phtDate(Date.now()); let after: string | undefined, complete = false;
  const deadline = Date.now() + 35000;
  for (let batch = 0; batch < 10 && Date.now() < deadline; batch++) {
   const result = await readMetaAds(body.accountId + '/insights', session.accessToken, { fields: DAILY_INSIGHT_FIELDS, level: 'ad', time_increment: '1',
    action_report_time: 'conversion', use_unified_attribution_setting: 'true', filtering: JSON.stringify([{ field: 'ad.id', operator: 'IN', value: ids }]),
    time_range: JSON.stringify({ since: from, until: to }), limit: '100', ...(after ? { after } : {}) });
   if (!Array.isArray(result.data)) throw Error('Facebook did not return a complete Insights response');
   for (const row of result.data) {
    const value = normalizeDailySpend(row, account, allowed, from, to);
    if (!value) throw Error('Facebook returned an ad outside the requested scope');
    const key = `${value.ad_id}:${value.spend_date}`;
    if (records.has(key)) throw Error('Facebook returned duplicate daily ad rows');
    records.set(key, { ...value, ...dailyDeliveryMetrics(row), report_complete: value.spend_date < today, reported_zero: false });
   }
   if (!result.paging?.next) { complete = true; break; }
   after = result.paging.cursors?.after;
   if (!after || seen.has(after)) throw Error('Facebook omitted or repeated a report continuation cursor');
   seen.add(after);
  }
  if (!complete) throw Error('This batch did not finish. No partial spend or invented zero days were saved; retry a shorter period.');
  // An absent row is a reported no-activity day only after the complete filtered
  // account report succeeds. Unimported days remain unknown everywhere else.
  const checkedAt = new Date().toISOString();
  for (let ms = Date.parse(from + 'T00:00:00Z'); ms <= Date.parse(to + 'T00:00:00Z'); ms += 86400000) {
   const day = new Date(ms).toISOString().slice(0, 10);
   for (const id of ids) if (!records.has(`${id}:${day}`)) records.set(`${id}:${day}`, {
    page_id: allowed.get(id), ad_id: id, account_id: body.accountId.slice(4), spend_date: day, currency: account.currency, account_timezone: account.timezone_name,
    pht_aligned: alignedWithPht(day, account.timezone_name), amount: 0, impressions: 0, clicks: 0, reach: 0, link_clicks: 0, messaging_started: 0,
    video_plays: 0, video_thruplays: 0, video_complete: 0, action_report_time: 'conversion', attribution_setting: 'adset_unified', report_complete: day < today, reported_zero: day < today, checked_at: checkedAt
   });
  }
  const saved = await db.from('ad_daily_spend').upsert([...records.values()], { onConflict: 'page_id,ad_id,spend_date,account_id' });
  if (saved.error) throw Error('Could not atomically save the completed report');
  return NextResponse.json({ saved: records.size, complete: true, currency: account.currency, timezone: account.timezone_name,
   pht_aligned: [...records.values()].every(row => row.pht_aligned), checked_at: checkedAt }, { headers: { 'Cache-Control': 'no-store' } });
 } catch (error) { const e = error as MetaAdAccessError; return NextResponse.json({ error: e.message || 'Insights are unavailable', requiresReconnect: !!e.reconnect }, { status: e.reconnect ? 409 : 503 }); }
}
