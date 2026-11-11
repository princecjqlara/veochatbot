import { alignedWithPht, DAILY_INSIGHT_FIELDS, dailyDeliveryMetrics, normalizeDailySpend } from './ad-daily-spend';
import { catalogMetadata, creativePageId, marketingConnection, readMetaAds } from './facebook-ad-catalog';
import { pageAdPlanning } from './veo-ad-planning';

const DAY = 86400000;
const shift = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
export function adSpendWindows(from: string, to: string) {
    if (![from, to].every(d => /^20\d{2}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) && shift(d, 0) === d) || from > to) throw Error('Invalid ad-spend dates');
    const windows: Array<{ from: string; to: string }> = [];
    for (let start = from; start <= to;) {
        const end = new Date(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)), 0)).toISOString().slice(0, 10);
        windows.push({ from: start, to: end < to ? end : to }); start = shift(windows.at(-1)!.to, 1);
    }
    return windows;
}
type Options = { db: any; token: string; pages: Array<{ id: string; fb_page_id: string }>; from: string; to: string;
    deadline?: number; authorize: () => Promise<string[]>; onProgress?: (value: any) => void; completed?: string[]; completedPages?: string[]; completedAccounts?: string[] };
/** A coverage record is written only after every connected account's unfiltered
 * daily report and creative ownership checks finish. No budgets or messages change. */
export async function refreshMetaAdSpend(options: Options) {
    const { db, token, pages, authorize } = options, today = shift(new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), 0);
    const windows = adSpendWindows(options.from, options.to);
    if (options.to > today || !pages.length) throw Error('Choose assigned Pages and completed/current dates');
    const ids = pages.map(p => p.id), pageByFacebook = new Map(pages.map(p => [p.fb_page_id, p.id]));
    const report = { started_at: new Date().toISOString(), complete: false, accounts: 0, pages: pages.length, inventory_ads: 0, saved_spend_rows: 0,
        coverage_days: 0, completed_windows: [...(options.completed || [])], page_ids: ids.slice().sort(), account_ids: [] as string[], from: options.from, to: options.to, errors: [] as string[] };
    const deadline = options.deadline || Date.now() + 30 * 60000;
    const progress = () => options.onProgress?.({ ...report });
    async function guard() {
        if (Date.now() >= deadline) throw Error('Ad refresh deadline reached; completed windows are retained for retry');
        const allowed = new Set(await authorize()); if (ids.some(id => !allowed.has(id))) throw Error('Page access changed during ad refresh');
    }
    async function read(path: string, params: Record<string, string>) {
        if (Date.now() >= deadline) throw Error('Ad refresh deadline reached');
        return readMetaAds(path, token, params);
    }
    async function paginate(path: string, params: Record<string, string>, consume: (rows: any[]) => void) {
        let after: string | undefined; const seen = new Set<string>();
        for (let i = 0; i < 100; i++) {
            const body = await read(path, { ...params, ...(after ? { after } : {}) });
            if (!Array.isArray(body.data)) throw Error('Meta returned an incomplete report');
            consume(body.data);
            if (!body.paging?.next) return;
            after = body.paging.cursors?.after;
            if (!after || seen.has(after)) throw Error('Meta returned an incomplete or repeated continuation cursor');
            seen.add(after);
        }
        throw Error('Meta report exceeded its pagination limit');
    }
    try {
        await guard(); const connection = await marketingConnection(token);
        if (connection.status !== 'ready' || (connection as any).partial || !connection.accounts.length) throw Error('Complete connected ad-account access is unavailable');
        report.accounts = connection.accounts.length; report.account_ids = connection.accounts.map(a => a.id).sort();
        if (JSON.stringify(report.page_ids) !== JSON.stringify(options.completedPages?.slice().sort()) || JSON.stringify(report.account_ids) !== JSON.stringify(options.completedAccounts?.slice().sort())) report.completed_windows = [];
        const accounts: Array<{ id: string; currency: string; timezone_name: string; ads: Map<string, string | null> }> = [], planningRows: any[] = [];
        for (const account of connection.accounts) {
            const metadata = await read(account.id, { fields: 'id,currency,timezone_name' });
            if (metadata.id !== account.id || !/^[A-Z]{3}$/.test(metadata.currency || '') || typeof metadata.timezone_name !== 'string') throw Error('Ad-account currency or timezone could not be verified');
            const ads = new Map<string, string | null>(), records: any[] = [], planningAds: any[] = [];
            await paginate(account.id + '/ads', { fields: 'id,name,account_id,effective_status,created_time,campaign{id,name,daily_budget,lifetime_budget},adset{id,name,daily_budget,lifetime_budget,start_time,end_time},creative{id,name,thumbnail_url,effective_object_story_id,object_story_id,object_story_spec}', limit: '100' }, values => {
                for (const ad of values) {
                    if (String(ad.account_id) !== account.id.slice(4) || !/^\d+$/.test(ad.id || '')) throw Error('Meta returned another account in its inventory');
                    const facebookPage = creativePageId(ad);
                    if (ad.effective_status === 'ACTIVE' && !facebookPage) throw Error('An active ad has unresolved Page ownership; no-ads planning cannot be certified');
                    // Unknown ownership remains unresolved. A historical Insights row
                    // must resolve it before any complete Page coverage can be saved.
                    if (facebookPage) ads.set(ad.id, pageByFacebook.get(facebookPage) || null);
                    const page = facebookPage && pageByFacebook.get(facebookPage);
                    planningAds.push({ ...ad, verified_page_id: page || null });
                    if (page) records.push(catalogMetadata(ad, page));
                }
            });
            await guard();
            for (let offset = 0; offset < records.length; offset += 500) {
                const saved = await db.rpc('save_ad_catalog_metadata', { p_records: records.slice(offset, offset + 500) });
                if (saved.error) throw Error('Could not save verified ad inventory');
            }
            report.inventory_ads += records.length;
            const planning = pageAdPlanning(planningAds, ids, metadata.currency, new Date().toISOString()).map(row => ({ ...row, account_id: account.id.slice(4) }));
            planningRows.push(...planning);
            accounts.push({ ...metadata, ads }); progress();
        }
        // Previously resolved historical creatives must stay in future refreshes.
        // Otherwise a later current-inventory refresh would omit their verified
        // zero rows and make its coverage disagree with retained historical rows.
        const byAccount = new Map(accounts.map(a => [a.id.slice(4), a]));
        for (let offset = 0; offset < 100000; offset += 1000) {
            const cached = await db.from('ad_source_catalog').select('page_id,ad_id,ad_account_id').in('page_id', ids).order('page_id').order('ad_id').range(offset, offset + 999);
            if (cached.error) throw Error('Could not load retained verified ad ownership');
            for (const ad of cached.data || []) {
                let account = byAccount.get(ad.ad_account_id);
                if (!account) {
                    const metadata = await read(ad.ad_id, { fields: 'id,name,account_id,effective_status,campaign{id,name},adset{id,name},creative{id,name,thumbnail_url,effective_object_story_id,object_story_id,object_story_spec}' });
                    const facebookPage = creativePageId(metadata);
                    account = byAccount.get(String(metadata.account_id));
                    if (metadata.id !== ad.ad_id || !account || !facebookPage || pageByFacebook.get(facebookPage) !== ad.page_id) throw Error('A saved referral creative belongs to an unverified or unconnected ad account. Reconnect the appropriate advertising accounts before certifying complete data.');
                    if (metadata.effective_status === 'ACTIVE' && !account.ads.has(ad.ad_id)) throw Error('Ad inventory changed during fetching. Retry to verify the active creative before detecting budgets.');
                    await guard();
                    const saved = await db.rpc('save_ad_catalog_metadata', { p_records: [catalogMetadata(metadata, ad.page_id)] });
                    if (saved.error) throw Error('Could not complete saved referral creative metadata');
                    report.inventory_ads++;
                }
                if (account.ads.has(ad.ad_id) && account.ads.get(ad.ad_id) !== ad.page_id) throw Error('A retained ad has conflicting Page ownership');
                account.ads.set(ad.ad_id, ad.page_id);
            }
            if ((cached.data || []).length < 1000) break;
            if (offset === 99000) throw Error('The retained ad inventory exceeds the bounded refresh limit');
        }
        await guard();
        const planned = await db.from('veo_ad_planning_state').upsert(planningRows, { onConflict: 'page_id,account_id' });
        if (planned.error) throw Error('Could not save verified daily ad-budget planning');
        const currencies = [...new Set(accounts.map(a => a.currency))];
        for (const window of windows) {
            const key = window.from + ':' + window.to;
            if (report.completed_windows.includes(key)) continue;
            const checkedAt = new Date().toISOString(), rows = new Map<string, any>();
            // Sequential account reads avoid flooding the shared Meta app quota.
            for (const account of accounts) {
                await paginate(account.id + '/insights', { fields: DAILY_INSIGHT_FIELDS, level: 'ad', time_increment: '1', action_report_time: 'conversion',
                    use_unified_attribution_setting: 'true', time_range: JSON.stringify({ since: window.from, until: window.to }), limit: '500' }, values => {
                    for (const raw of values) {
                        const id = String(raw.ad_id || ''), rowKey = account.id + ':' + id + ':' + raw.date_start;
                        if (!/^\d+$/.test(id) || rows.has(rowKey)) throw Error('Meta returned a missing or duplicate ad identity');
                        rows.set(rowKey, { raw, account });
                    }
                });
                // Historical Insights can include deleted/archived ads omitted by
                // current inventory. Resolve them explicitly instead of dropping spend.
                const unresolved = [...rows.values()].filter(r => r.account.id === account.id && !account.ads.has(String(r.raw.ad_id)));
                for (const id of new Set<string>(unresolved.map(r => String(r.raw.ad_id)))) {
                    const ad = await read(id, { fields: 'id,name,account_id,effective_status,campaign{id,name},adset{id,name},creative{id,name,thumbnail_url,effective_object_story_id,object_story_id,object_story_spec}' });
                    const facebookPage = creativePageId(ad);
                    if (ad.id !== id || String(ad.account_id) !== account.id.slice(4) || !facebookPage) throw Error('A historical ad has unverified Page ownership; spend coverage remains incomplete');
                    const page = pageByFacebook.get(facebookPage) || null; account.ads.set(id, page);
                    if (page) { await guard(); const saved = await db.rpc('save_ad_catalog_metadata', { p_records: [catalogMetadata(ad, page)] }); if (saved.error) throw Error('Could not save historical ad ownership'); }
                }
            }
            const records: any[] = [], totals = new Map<string, { amount: number; ads: Set<string> }>();
            for (const { raw, account } of rows.values()) {
                const page = account.ads.get(String(raw.ad_id)); if (!page) continue;
                const value = normalizeDailySpend(raw, account, new Map([[String(raw.ad_id), page]]), window.from, window.to);
                if (!value) throw Error('Ad spend could not be assigned to an authorized Page');
                records.push({ ...value, ...dailyDeliveryMetrics(raw), checked_at: checkedAt, report_complete: value.spend_date < today, reported_zero: false });
            }
            // Zero rows are allowed only after the complete, unfiltered reports
            // above succeed. They never stand in for an unqueried account.
            for (const account of accounts) for (const [ad, page] of account.ads) if (page) {
                for (let day = window.from; day <= window.to; day = shift(day, 1)) {
                    if (!rows.has(account.id + ':' + ad + ':' + day)) records.push({ page_id: page, ad_id: ad, account_id: account.id.slice(4), spend_date: day,
                        currency: account.currency, account_timezone: account.timezone_name, pht_aligned: alignedWithPht(day, account.timezone_name), amount: 0,
                        impressions: 0, clicks: 0, reach: 0, frequency: null, link_clicks: 0, messaging_started: 0, video_plays: 0, video_thruplays: 0, video_complete: 0,
                        action_report_time: 'conversion', attribution_setting: 'adset_unified', checked_at: checkedAt, report_complete: day < today, reported_zero: day < today });
                }
            }
            for (const r of records) {
                const k = [r.page_id, r.spend_date, r.currency].join(':'); const t = totals.get(k) || { amount: 0, ads: new Set<string>() };
                t.amount += Math.round(r.amount * 100); t.ads.add(r.ad_id); totals.set(k, t);
            }
            const coverage: any[] = [];
            for (const page of ids) for (let day = window.from; day <= window.to; day = shift(day, 1)) for (const currency of currencies) {
                const t = totals.get([page, day, currency].join(':'));
                coverage.push({ page_id: page, spend_date: day, currency, amount_minor: t?.amount || 0, ad_count: t?.ads.size || 0,
                    accounts_checked: accounts.length, checked_at: checkedAt, report_complete: day < today,
                    pht_aligned: accounts.filter(a => a.currency === currency).every(a => alignedWithPht(day, a.timezone_name)) });
            }
            await guard();
            for (let offset = 0; offset < records.length; offset += 500) { const saved = await db.from('ad_daily_spend').upsert(records.slice(offset, offset + 500), { onConflict: 'page_id,ad_id,spend_date,account_id' }); if (saved.error) throw Error('Could not save daily ad spend'); }
            // Only the coverage write makes a report complete. Failed/partial spend
            // writes stay partial, and a retry replaces their stable primary keys.
            for (let offset = 0; offset < coverage.length; offset += 500) { const saved = await db.from('veo_ad_spend_coverage').upsert(coverage.slice(offset, offset + 500), { onConflict: 'page_id,spend_date,currency' }); if (saved.error) throw Error('Could not save ad-spend coverage'); }
            report.saved_spend_rows += records.length; report.coverage_days += coverage.length;
            report.completed_windows.push(key); progress();
        }
        report.complete = true;
    } catch (error) { report.errors.push(error instanceof Error ? error.message : 'Meta Ads refresh failed'); }
    progress(); return report;
}
