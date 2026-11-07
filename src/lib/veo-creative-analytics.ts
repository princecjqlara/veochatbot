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
    const clients = input.clients || [], orders = input.orders || [], cash = input.cash || [], spend = input.spend || [], coverage = input.coverage || [];
    const days: string[] = []; for (let at = Date.parse(input.from); at <= Date.parse(input.to); at += 86400000) days.push(new Date(at).toISOString().slice(0, 10));
    const ids = new Set<string>([...(input.ads || []).map((a: any) => a.ad_id), ...clients.map((c: any) => c.ad_id), ...spend.map((s: any) => s.ad_id)]);
    function report(ad: string, selectedDay?: string): any {
        const cohort = clients.filter((c: any) => c.ad_id === ad && (!selectedDay || day(c.inquiry_at) === selectedDay)), contacts = new Set(cohort.map((c: any) => c.id));
        const ownOrders = orders.filter((o: any) => contacts.has(o.contact_id)), payments = cash.filter((p: any) => contacts.has(p.contact_id)), ads = spend.filter((s: any) => s.ad_id === ad && (!selectedDay || s.spend_date === selectedDay));
        const paid = ownOrders.filter((o: any) => o.closed_at && o.paid_minor > 0), done = ownOrders.filter((o: any) => o.done_at), payers = new Set(paid.map((o: any) => o.contact_id));
        const converted = cohort.filter((c: any) => c.converted_at || c.stage === 'converted').length;
        const currencies = new Set<string>([...ads.map((s: any) => s.currency), ...payments.map((p: any) => p.currency), ...ownOrders.map((o: any) => o.currency)]);
        const money = [...currencies].map(currency => {
            const rows = ads.filter((s: any) => s.currency === currency), validDays = selectedDay ? [selectedDay] : days;
            const complete = validDays.every(date => coverage.some((c: any) => c.spend_date === date && c.currency === currency && c.report_complete && c.pht_aligned));
            const own = ownOrders.filter((o: any) => o.currency === currency), settled = own.filter((o: any) => o.done_at), paidOrders = paid.filter((o: any) => o.currency === currency);
            const received = sum(payments.filter((p: any) => p.currency === currency), 'amount_minor'), amount = rows.length || complete ? Math.round(sum(rows, 'amount') * 100) : null;
            const salary = settled.some((o: any) => o.commission_minor == null) ? null : sum(settled, 'commission_minor');
            const uniquePayers = new Set(paidOrders.map((o: any) => o.contact_id)).size;
            const matching = payments.every((p: any) => p.currency === currency || !Number(p.amount_minor));
            return { currency, gross_minor: received, completed_order_gross_minor: sum(settled, 'paid_minor'), salary_minor: salary, ad_spend_minor: amount,
                net_minor: complete && matching && salary != null && amount != null ? received - salary - amount : null,
                net_roas: complete && matching && salary != null && amount != null ? ratio(received - salary, amount) : null,
                paid_orders: paidOrders.length, average_order_minor: paidOrders.length ? sum(paidOrders, 'total_minor') / paidOrders.length : null,
                cost_per_purchase_minor: complete && amount != null ? ratio(amount, paidOrders.length) : null,
                cost_per_acquisition_minor: complete && amount != null ? ratio(amount, uniquePayers) : null,
                average_daily_spend_minor: complete && amount != null ? amount / validDays.length : null, spend_complete: complete };
        });
        const frequencyRows = ads.filter((s: any) => s.frequency != null && s.reach > 0), weights = sum(frequencyRows, 'reach');
        const history = (input.delivery_history || []).find((h: any) => h.ad_id === ad);
        return { ad_id: ad, ad: (input.ads || []).find((a: any) => a.ad_id === ad), inquiries: cohort.length, converted, qualified: cohort.filter((c: any) => c.stage === 'qualified').length,
            not_qualified: cohort.filter((c: any) => c.stage === 'not_qualified').length, pending: cohort.filter((c: any) => !['qualified', 'not_qualified', 'converted'].includes(c.stage)).length,
            conversion_rate: ratio(converted, cohort.length), paying_clients: payers.size, paid_orders: paid.length, done_orders: done.length, finance: money,
            mean_inquiry_to_conversion_hours: mean(cohort.filter((c: any) => c.converted_at && Date.parse(c.converted_at) >= Date.parse(c.inquiry_at)).map((c: any) => (Date.parse(c.converted_at) - Date.parse(c.inquiry_at)) / 3600000)),
            first_delivery_date: history?.first_delivery_date || null, latest_delivery_date: history?.latest_delivery_date || null, recorded_delivery_days: Number(history?.delivery_days || 0),
            running_calendar_days: history?.first_delivery_date ? Math.floor((Date.parse(day(input.as_of)) - Date.parse(history.first_delivery_date)) / 86400000) + 1 : null,
            daily_frequency_weighted_mean: weights ? frequencyRows.reduce((n: number, r: any) => n + Number(r.frequency) * Number(r.reach), 0) / weights : null,
            impressions: ads.some((s: any) => s.impressions != null) ? sum(ads, 'impressions') : null,
            demographics: selectedDay ? [] : creativeDemographics(cohort), subdemographics: selectedDay ? [] : demographicSubgroups(cohort) };
    }
    const ads = [...ids].map(id => report(id)).sort((a, b) => b.inquiries - a.inquiries || a.ad_id.localeCompare(b.ad_id));
    return { from: input.from, to: input.to, generated_at: input.as_of, ads, daily: [...ids].flatMap(id => days.map(date => ({ ...report(id, date), day: date }))),
        ad_planning: input.ad_planning || [], coverage: { attribution: 'Only verified originating-ad relationships. Unattributed inquiries are excluded, never guessed.',
            financials: 'Inquiry-cohort verified payments received through now less refunds. Net subtracts actual commission on completed orders and acquisition-date ads; future commission, other costs and taxes are excluded. Retained salary may be unavailable.',
            frequency: 'Daily frequency comes from Meta. The range summary is a reach-weighted daily mean, not deduplicated whole-period frequency. Exact selected-ad range frequency is shown when Meta can return it.',
            runtime: 'First/last recorded delivery and recorded delivery dates; this is not proof of uninterrupted running or complete pre-launch delivery history.' } };
}
