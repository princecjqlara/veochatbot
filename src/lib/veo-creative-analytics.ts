import { recordedDemographics, demographicSubgroups } from './veo-demographics';
const sum = (rows: any[], key: string) => rows.reduce((n, r) => n + Number(r[key] || 0), 0);
const ratio = (a: number, b: number) => b > 0 ? a / b : null;
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const day = (v: string) => new Date(Date.parse(v) + 8 * 3600000).toISOString().slice(0, 10);
export function creativeDemographics(clients: any[]) {
    return ['industry', 'business_type', 'age', 'gender', 'country', 'city'].map(key => {
        const values = clients.map(c => recordedDemographics(c).find(f => f.key === key)?.value || 'Unknown'), counts = new Map<string, number>();
        for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
        return { key, total: values.length, rows: [...counts].map(([label, count]) => ({ label, count, percent: ratio(count, values.length) })).sort((a, b) => b.count - a.count) };
    });
}
export function buildCreativeReport(input: any) {
    const unique = (rows: any[], key: (row: any) => string | undefined) => {
        const seen = new Map<string, any>(); return rows.filter(row => { const id = key(row); if (!id) return true;
            if (seen.has(id)) { if (JSON.stringify(seen.get(id)) !== JSON.stringify(row)) throw Error('Conflicting creative financial evidence; refresh the report'); return false; }
            seen.set(id, row); return true; });
    };
    const clients = unique(input.clients || [], c => c.id), orders = unique(input.orders || [], o => o.order_key || (o.id ? `${o.financial_source || 'workspace'}:${o.id}` : undefined));
    const cash = unique(input.cash || [], p => p.payment_key), spend = input.spend || [], reconciled = input.reconciled_spend || [];
    const today = day(input.as_of);
    const days: string[] = []; for (let at = Date.parse(input.from); at <= Date.parse(input.to); at += 86400000) days.push(new Date(at).toISOString().slice(0, 10));
    const ids = new Set<string>([...(input.ads || []).map((a: any) => a.ad_id), ...clients.map((c: any) => c.ad_id), ...spend.map((s: any) => s.ad_id)]);
    const origin = new Map<string, string>(clients.map((c: any) => [c.id, c.ad_id]));
    const group = (rows: any[], key: (row: any) => string | undefined) => { const result = new Map<string, any[]>(); for (const row of rows) { const id = key(row); if (id) { if (!result.has(id)) result.set(id, []); result.get(id)!.push(row); } } return result; };
    const clientGroups = group(clients, c => c.ad_id), orderGroups = group(orders, o => origin.get(o.contact_id)), paymentGroups = group(cash, p => origin.get(p.contact_id)), spendGroups = group(spend, s => s.ad_id);
    function report(ad: string, selectedDay?: string): any {
        const cohort = (clientGroups.get(ad) || []).filter((c: any) => !selectedDay || day(c.inquiry_at) === selectedDay), contacts = new Set(cohort.map((c: any) => c.id));
        const ownOrders = (orderGroups.get(ad) || []).filter((o: any) => !selectedDay || contacts.has(o.contact_id)), payments = (paymentGroups.get(ad) || []).filter((p: any) => !selectedDay || contacts.has(p.contact_id)), ads = (spendGroups.get(ad) || []).filter((s: any) => !selectedDay || s.spend_date === selectedDay);
        const paid = ownOrders.filter((o: any) => o.closed_at && o.paid_minor > 0), done = ownOrders.filter((o: any) => o.done_at), payers = new Set(paid.map((o: any) => o.contact_id));
        const cashByClient = new Map<string, number>(); for (const payment of payments) cashByClient.set(payment.contact_id, (cashByClient.get(payment.contact_id) || 0) + Number(payment.amount_minor));
        for (const [client, value] of cashByClient) if (value > 0) payers.add(client);
        const converted = cohort.filter((c: any) => c.converted_at || c.stage === 'converted').length;
        const currencies = new Set<string>([...ads.map((s: any) => s.currency), ...payments.map((p: any) => p.currency), ...ownOrders.map((o: any) => o.currency)]);
        const money = [...currencies].map(currency => {
            const rows = ads.filter((s: any) => s.currency === currency), validDays = selectedDay ? [selectedDay] : days;
            const knownDays = validDays.filter(date => date < today && reconciled.some((c: any) => c.spend_date === date && c.currency === currency && c.complete === true)
                && rows.some((row: any) => row.spend_date === date) && rows.filter((row: any) => row.spend_date === date).every((row: any) => row.pht_aligned === true && row.report_complete === true));
            const complete = knownDays.length === validDays.length;
            const own = ownOrders.filter((o: any) => o.currency === currency), settled = own.filter((o: any) => o.done_at), paidOrders = paid.filter((o: any) => o.currency === currency);
            const received = sum(payments.filter((p: any) => p.currency === currency), 'amount_minor'), amount = rows.length || complete ? Math.round(sum(rows, 'amount') * 100) : null;
            const salary = settled.some((o: any) => o.commission_minor == null) || payments.some((p: any) => p.currency === currency && p.financial_source === 'retained') ? null : sum(settled, 'commission_minor');
            const currencyPayers = new Set(paidOrders.map((o: any) => o.contact_id)), netByClient = new Map<string, number>();
            for (const payment of payments.filter((p: any) => p.currency === currency)) netByClient.set(payment.contact_id, (netByClient.get(payment.contact_id) || 0) + Number(payment.amount_minor));
            for (const [client, value] of netByClient) if (value > 0) currencyPayers.add(client);
            const uniquePayers = currencyPayers.size;
            const matching = payments.every((p: any) => p.currency === currency || !Number(p.amount_minor));
            return { currency, gross_minor: received, completed_order_gross_minor: sum(settled, 'paid_minor'), salary_minor: salary, ad_spend_minor: amount,
                net_minor: complete && matching && salary != null && amount != null ? received - salary - amount : null,
                net_roas: complete && matching && salary != null && amount != null ? ratio(received - salary, amount) : null,
                gross_roas: complete && matching && amount != null ? ratio(received, amount) : null,
                profit_roi: complete && matching && salary != null && amount != null ? ratio(received - salary - amount, amount) : null,
                paid_orders: paidOrders.length, average_order_minor: paidOrders.length ? sum(paidOrders, 'total_minor') / paidOrders.length : null,
                cost_per_purchase_minor: complete && amount != null ? ratio(amount, paidOrders.length) : null,
                cost_per_acquisition_minor: complete && amount != null ? ratio(amount, uniquePayers) : null,
                average_daily_spend_minor: complete && amount != null ? amount / validDays.length : null, spend_complete: complete,
                cost_per_inquiry_minor: complete && amount != null ? ratio(amount, cohort.length) : null,
                cost_per_conversion_minor: complete && amount != null ? ratio(amount, converted) : null,
                spend_known_days: knownDays.length, spend_expected_days: validDays.length };
        });
        const deliveryComplete = ads.length > 0 && [...new Set(ads.map((r: any) => r.currency))].every(currency => money.find(f => f.currency === currency)?.spend_complete);
        const deliveryDays = selectedDay ? [selectedDay] : days;
        // Today can have a fully fetched snapshot without being a finished day.
        // Require matching source checks so a half-written import never becomes
        // a provisional zero or a complete-looking delivery total.
        const deliveryProvisional = !deliveryComplete && deliveryDays.includes(today) && ads.length > 0 && [...new Set(ads.map((r: any) => r.currency))].every(currency => deliveryDays.every(date => {
            const rows = ads.filter((r: any) => r.currency === currency && r.spend_date === date);
            if (!rows.length || rows.some((r: any) => r.pht_aligned !== true)) return false;
            if (date < today) return reconciled.some((r: any) => r.spend_date === date && r.currency === currency && r.complete === true) && rows.every((r: any) => r.report_complete === true);
            if (date !== today) return false;
            const coverage = (input.coverage || []).filter((r: any) => r.spend_date === date && r.currency === currency);
            return coverage.length > 0 && coverage.every((r: any) => r.pht_aligned === true && r.accounts_checked > 0 && Number.isFinite(Date.parse(r.checked_at))) && rows.every((r: any) => coverage.some((c: any) => Date.parse(r.checked_at) === Date.parse(c.checked_at)));
        }));
        const metric = (field: string) => (deliveryComplete || deliveryProvisional) && ads.length && ads.every((r: any) => r[field] != null && Number.isFinite(Number(r[field])) && Number(r[field]) >= 0) ? sum(ads, field) : null;
        const impressions = metric('impressions'), clicks = metric('clicks'), linkClicks = metric('link_clicks'), conversations = metric('messaging_started'), plays = metric('video_plays'), thruplays = metric('video_thruplays'), completions = metric('video_complete');
        money.forEach(f => Object.assign(f, { cpc_minor: f.spend_complete && f.ad_spend_minor != null && clicks != null ? ratio(f.ad_spend_minor, clicks) : null,
            cost_per_link_click_minor: f.spend_complete && f.ad_spend_minor != null && linkClicks != null ? ratio(f.ad_spend_minor, linkClicks) : null,
            cpm_minor: f.spend_complete && f.ad_spend_minor != null && impressions != null ? ratio(f.ad_spend_minor * 1000, impressions) : null,
            cost_per_message_minor: f.spend_complete && f.ad_spend_minor != null && conversations != null ? ratio(f.ad_spend_minor, conversations) : null,
            cost_per_thruplay_minor: f.spend_complete && f.ad_spend_minor != null && thruplays != null ? ratio(f.ad_spend_minor, thruplays) : null,
            cost_per_video_play_minor: f.spend_complete && f.ad_spend_minor != null && plays != null ? ratio(f.ad_spend_minor, plays) : null }));
        const frequencyRows = ads.filter((s: any) => s.frequency != null && s.reach > 0), weights = sum(frequencyRows, 'reach');
        const dailyFrequency = (deliveryComplete || deliveryProvisional) && weights && ads.every((r: any) => r.reach != null && (Number(r.reach) === 0 || r.frequency != null)) ? frequencyRows.reduce((n: number, r: any) => n + Number(r.frequency) * Number(r.reach), 0) / weights : null;
        money.forEach(f => Object.assign(f, { provisional_delivery_costs: deliveryProvisional && f.ad_spend_minor != null ? {
            cpc_minor: clicks == null ? null : ratio(f.ad_spend_minor, clicks), cost_per_link_click_minor: linkClicks == null ? null : ratio(f.ad_spend_minor, linkClicks),
            cpm_minor: impressions == null ? null : ratio(f.ad_spend_minor * 1000, impressions), cost_per_message_minor: conversations == null ? null : ratio(f.ad_spend_minor, conversations),
            cost_per_thruplay_minor: thruplays == null ? null : ratio(f.ad_spend_minor, thruplays), cost_per_video_play_minor: plays == null ? null : ratio(f.ad_spend_minor, plays)
        } : null }));
        const history = (input.delivery_history || []).find((h: any) => h.ad_id === ad);
        return { ad_id: ad, ad: (input.ads || []).find((a: any) => a.ad_id === ad), inquiries: cohort.length, converted, qualified: cohort.filter((c: any) => c.stage === 'qualified').length,
            not_qualified: cohort.filter((c: any) => c.stage === 'not_qualified').length, pending: cohort.filter((c: any) => !['qualified', 'not_qualified', 'converted'].includes(c.stage)).length,
            conversion_rate: ratio(converted, cohort.length), paying_clients: payers.size, paid_orders: paid.length, done_orders: done.length, finance: money,
            mean_inquiry_to_conversion_hours: mean(cohort.filter((c: any) => c.converted_at && Date.parse(c.converted_at) >= Date.parse(c.inquiry_at)).map((c: any) => (Date.parse(c.converted_at) - Date.parse(c.inquiry_at)) / 3600000)),
            first_delivery_date: history?.first_delivery_date || null, latest_delivery_date: history?.latest_delivery_date || null, recorded_delivery_days: Number(history?.delivery_days || 0),
            running_calendar_days: history?.first_delivery_date ? Math.floor((Date.parse(day(input.as_of)) - Date.parse(history.first_delivery_date)) / 86400000) + 1 : null,
            daily_frequency_weighted_mean: dailyFrequency,
            // Reach is unique within one reporting day. Whole-period reach must
            // come from a separate range Insights read, never a daily sum.
            reach: selectedDay ? metric('reach') : null, frequency: selectedDay ? dailyFrequency : null,
            impressions, clicks, link_clicks: linkClicks, messaging_started: conversations, video_plays: plays, video_thruplays: thruplays, video_complete: completions,
            ctr: impressions != null && clicks != null ? ratio(clicks, impressions) : null,
            link_ctr: impressions != null && linkClicks != null ? ratio(linkClicks, impressions) : null,
            video_completion_rate: plays != null && completions != null ? ratio(completions, plays) : null,
            delivery_complete: deliveryComplete, delivery_provisional: deliveryProvisional,
            demographics: selectedDay ? [] : creativeDemographics(cohort), subdemographics: selectedDay ? [] : demographicSubgroups(cohort) };
    }
    const ads = [...ids].map(id => report(id)).sort((a, b) => b.inquiries - a.inquiries || Number(b.impressions || 0) - Number(a.impressions || 0) || Number(b.ad?.ad_status === 'ACTIVE') - Number(a.ad?.ad_status === 'ACTIVE') || a.ad_id.localeCompare(b.ad_id));
    const selected = input.selected_ad || ads[0]?.ad_id;
    return { from: input.from, to: input.to, generated_at: input.as_of, ads, daily_ad_id: selected || null, daily: selected && ids.has(selected) ? days.map(date => ({ ...report(selected, date), day: date })) : [],
        attribution_coverage: input.attribution_coverage || null, ad_planning: input.ad_planning || [], coverage: { attribution: 'Only verified originating-ad relationships. Unattributed inquiries are excluded, never guessed. Imported contact identities alone do not prove an inquiry date or originating ad.',
            financials: 'Inquiry-cohort verified receipts through now less refunds. Revenue ROAS = receipts / ads; after-commission ROAS = (receipts - actual commission) / ads; profit ROI = (receipts - commission - ads) / ads. Future commission, other costs and taxes are excluded. Retained salary may be unavailable. Current-day and unreconciled costs cannot certify final ratios.',
            frequency: 'Daily frequency comes from Meta. The range summary is a reach-weighted daily mean, not deduplicated whole-period frequency. Exact selected-ad range frequency is shown when Meta can return it.',
            runtime: 'First/last recorded delivery and recorded delivery dates; this is not proof of uninterrupted running or complete pre-launch delivery history.' } };
}
