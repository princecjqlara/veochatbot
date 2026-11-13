import { recordedDemographics, demographicSubgroups } from './veo-demographics';
import { calendarRange } from './ad-calendar';
import { calendarEarnings, createdOrderTotals } from './veo-calendar-earnings';

const DAY = 86400000;
const dayOf = (date: string) => new Date(Date.parse(date) + 8 * 3600000).toISOString().slice(0, 10);
const sum = (rows: any[], field: string) => rows.reduce((n, r) => n + Number(r[field] || 0), 0);
const ratio = (a: number, b: number) => b > 0 ? a / b : null;
const mean = (a: number[]) => a.length ? a.reduce((s, n) => s + n, 0) / a.length : null;
const median = (a: number[]) => { const s = [...a].sort((a, b) => a - b); return s.length ? (s[Math.floor((s.length - 1) / 2)] + s[Math.floor(s.length / 2)]) / 2 : null; };
const text = (v: unknown) => typeof v === 'string' || typeof v === 'number' ? String(v).trim().replace(/\s+/g, ' ').slice(0, 160) : '';
function field(c: any, aliases: string[]) {
    const records = recordedDemographics(c);
    for (const alias of aliases) { const found = records.find(r => r.key === alias); if (found && found.source !== 'unknown') return found.value; }
    return 'Unknown';
}
export function demographics(clients: any[]) {
    return [
        ['Age', ['age', 'edad'], (v: string) => /^\d{1,3}$/.test(v) && Number(v) <= 120 ? Number(v) < 18 ? 'Under 18' : Number(v) < 25 ? '18–24' : Number(v) < 35 ? '25–34' : Number(v) < 45 ? '35–44' : Number(v) < 55 ? '45–54' : Number(v) < 65 ? '55–64' : '65+' : 'Unknown'],
        ['Gender', ['gender', 'sex', 'kasarian'], (v: string) => /^(m|male|man|lalaki)$/i.test(v) ? 'Male' : /^(f|female|woman|babae)$/i.test(v) ? 'Female' : v],
        ['Location', ['city', 'location', 'province', 'country'], (v: string) => v],
        ['Industry', ['industry', 'business_type', 'business category'], (v: string) => v]
    ].map(([dimension, aliases, format]: any) => {
        const counts = new Map<string, { label: string; count: number }>();
        for (const c of clients) { const label = format(field(c, aliases)), key = label.toLowerCase(); const row = counts.get(key) || { label, count: 0 }; row.count++; counts.set(key, row); }
        const rows = [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).map(r => ({ ...r, percent: ratio(r.count, clients.length) }));
        return { dimension, total: clients.length, known: clients.length - (counts.get('unknown')?.count || 0), rows };
    });
}
export function objections(clients: any[]) {
    const groups = new Map<string, Set<string>>(); let reviewed = 0;
    for (const c of clients) {
        if (c.profile_as_of) reviewed++;
        for (const f of c.objections || []) {
            if (!f.evidence?.length) continue;
            const value = text(f.value), key = /mahal|expens|afford|budget|price|presyo|cost/i.test(value) ? 'Price / budget' : /trust|scam|legit|proof|tiwala/i.test(value) ? 'Trust / proof' : /time|deadline|urgent|oras|rush/i.test(value) ? 'Time / deadline' : /quality|sample|design|revision/i.test(value) ? 'Quality / revisions' : /payment|bayad|deposit|gcash/i.test(value) ? 'Payment terms' : value || 'Other recorded objection';
            const ids = groups.get(key) || new Set<string>(); ids.add(c.id); groups.set(key, ids);
        }
    }
    return { reviewed, total: clients.length, rows: [...groups].map(([label, ids]) => ({ label, clients: ids.size, percent: ratio(ids.size, clients.length) })).sort((a, b) => b.clients - a.clients).slice(0, 12) };
}
export function cohortProjection(leads: any[], peers: Array<number | null>, now: number) {
    const converted = leads.filter(c => c.converted_at || c.stage === 'converted').length, remaining = leads.length - converted;
    const age = leads.length ? Math.max(0, (now - leads.reduce((latest, c) => Math.max(latest, Date.parse(c.inquiry_at)), 0)) / 3600000) : 0;
    const eligible = peers.filter(lag => lag == null || lag > age), wins = eligible.filter(lag => lag != null && lag <= 720).length;
    const common = { recorded_converted: converted, remaining_clients: remaining, peer_sample: eligible.length, horizon_days: 30, cohort_age_hours: age };
    if (!leads.length) return { ...common, status: 'no_inquiries', additional: null, lower: null, upper: null };
    if (age >= 720) return { ...common, status: 'window_complete', additional: null, lower: null, upper: null, later_peer_conversions: peers.filter(lag => lag != null && lag > 720).length };
    if (!remaining) return { ...common, status: 'all_recorded_converted', additional: 0, lower: 0, upper: 0 };
    if (eligible.length < 30) return { ...common, status: 'insufficient_history', additional: null, lower: null, upper: null };
    const n = eligible.length, p = wins / n, z = 1.96, denominator = 1 + z * z / n;
    const center = (p + z * z / (2 * n)) / denominator, margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator;
    return { ...common, status: 'estimated', additional: remaining * p, lower: remaining * Math.max(0, center - margin), upper: remaining * Math.min(1, center + margin) };
}
function financials(orders: any[], cash: any[], spend: any[], pageCount: number, beforeLaunch: boolean, reportCurrencies: string[] = []) {
    const currencies = [...new Set<string>([...reportCurrencies, ...[...orders, ...cash, ...spend].map(r => r.currency)])];
    return currencies.map(currency => {
        const o = orders.filter(r => r.currency === currency), payments = cash.filter(r => r.currency === currency), ads = spend.filter(r => r.currency === currency);
        const done = o.filter(r => r.done_at), values = done.map(r => Number(r.total_minor));
        const amount = ads.length && ads.every(r => r.amount_minor != null) ? sum(ads, 'amount_minor') : null, salaryKnown = !done.some(r => r.commission_minor == null) && !payments.some(r => r.source === 'retained');
        const salary = salaryKnown ? sum(done, 'commission_minor') : null, gross = sum(done, 'paid_minor'), received = sum(payments, 'amount_minor');
        const mixedRevenue = [...orders, ...cash].some(r => r.currency !== currency && Number(r.paid_minor || r.amount_minor || 0) !== 0);
        const allPages = new Set(ads.map(r => r.page_id)).size === pageCount;
        const spendComplete = amount != null && allPages && ads.every(r => r.complete);
        const spendUsable = amount != null && allPages && ads.every(r => r.complete || r.provisional);
        const provisional = spendUsable && !spendComplete;
        return { currency, gross_minor: gross, received_minor: received,
            gross_before_refunds_minor: done.every(r => r.gross_before_refunds_minor != null) ? sum(done, 'gross_before_refunds_minor') : null,
            refunds_minor: done.every(r => r.refunds_minor != null) ? sum(done, 'refunds_minor') : null,
            salary_minor: salary, known_salary_minor: sum(done, 'commission_minor'), ad_spend_minor: amount,
            spend_complete: spendComplete, spend_usable: spendUsable, provisional, spend_pages_observed: ads.filter(r => r.complete || r.provisional).length, financial_blocker: mixedRevenue ? 'currency_mismatch' : !spendUsable ? 'spend_missing' : salary == null ? 'salary_missing' : amount === 0 ? 'zero_spend' : null, spend_pages_covered: ads.filter(r => r.complete).length, spend_pages_expected: pageCount,
            spend_accounts_checked: Math.max(0, ...ads.map(r => Number(r.accounts_checked || 0))),
            spend_checked_at: ads.map(r => r.checked_at).filter(Boolean).sort()[0] || null,
            mean_order_minor: mean(values), median_order_minor: median(values), done_orders: done.length, net_minor: !mixedRevenue && spendUsable && salary != null ? gross - salary - amount! : null,
            cash_net_minor: !mixedRevenue && spendUsable && salary != null ? received - salary - amount! : null, gross_roas: !mixedRevenue && spendUsable ? ratio(gross, amount!) : null,
            cash_roas: !mixedRevenue && spendUsable ? ratio(received, amount!) : null,
            net_roas: !mixedRevenue && spendUsable && salary != null ? ratio(gross - salary, amount!) : null,
            cash_net_roas: !mixedRevenue && spendUsable && salary != null ? ratio(received - salary, amount!) : null,
            legacy_salary_unknown: done.filter(r => r.commission_minor == null).length };
    });
}
function quotaProgress(actual: number, target: number | null) { return { actual, target, percent: target != null ? ratio(actual, target) : null, remaining: target == null ? null : Math.max(0, target - actual), surplus: target == null ? null : Math.max(0, actual - target), status: target == null || target === 0 ? 'unavailable' : actual > target ? 'surpassed' : actual === target ? 'reached' : 'below' }; }
export function buildVeoCalendar(input: any, finance: any, month: string, selectedDay: string, pageId: string | null = null) {
    const now = Date.parse(input.as_of), range = calendarRange(month, now), launchDay = dayOf(input.scope.launch_at);
    const leads = input.leads || [], orders = input.orders || [], payments = input.cash || [], spends = input.spend || [];
    const createdOrders = input.created_orders || [];
    const currencies = [...new Set<string>([...orders, ...payments, ...spends, ...createdOrders].map(r => r.currency))];
    if (!currencies.length) currencies.push('PHP');
    const group = (rows: any[], key: (row: any) => string) => {
        const map = new Map<string, any[]>(); for (const row of rows) { const k = key(row), list = map.get(k); if (list) list.push(row); else map.set(k, [row]); } return map;
    };
    const leadsByDay = group(leads, c => dayOf(c.inquiry_at)), doneByDay = group(orders, o => o.done_date), closedByDay = group(orders, o => o.closed_date);
    const cashByDay = group(payments, p => p.paid_day), cashByContact = group(payments, p => p.contact_id), spendByDay = group(spends, s => s.spend_date);
    const createdByDay = group(createdOrders, o => o.created_date);
    const byContact = group(orders, o => o.contact_id);
    const cohort = (day: string) => {
        const clients = leadsByDay.get(day) || [], convertedIds = new Set(clients.filter(c => c.stage === 'converted').map(c => c.id));
        const co = clients.flatMap(c => byContact.get(c.id) || []), cash = clients.flatMap(c => cashByContact.get(c.id) || []).filter((p: any) => p.paid_day >= day &&
            (p.source !== 'workspace' || convertedIds.has(p.contact_id)));
        const converted = clients.filter((c: any) => c.converted_at || c.stage === 'converted'), payers = new Set(co.filter((o: any) => o.closed_at && Number(o.paid_minor) > 0).map((o: any) => o.contact_id));
        const money = financials(co, cash, spends.filter((s: any) => s.spend_date === day), input.pages.length, day < launchDay && !co.some((o: any) => o.financial_source === 'workspace' && o.done_at)).map(f => ({ ...f,
            acquisition_cost_minor: f.spend_usable ? ratio(f.ad_spend_minor!, payers.size) : null, cost_per_inquiry_minor: f.spend_usable ? ratio(f.ad_spend_minor!, clients.length) : null,
            paid_customers: payers.size, net_minor: f.cash_net_minor, gross_roas: f.cash_roas, net_roas: f.cash_net_roas }));
        return { closed: co.filter((o: any) => o.closed_at).length, done: co.filter((o: any) => o.done_at).length, created_orders: createdOrders.filter((o: any) => clients.some((c: any) => c.id === o.contact_id)).length, inquiries: clients.length, converted: converted.length, converted_later: converted.filter((c: any) => c.converted_at && dayOf(c.converted_at) > day).length,
            conversion_time_unknown: converted.filter((c: any) => !c.converted_at).length, conversion_rate: ratio(converted.length, clients.length), paid_customers: payers.size, paid_rate: ratio(payers.size, clients.length),
            qualified: clients.filter((c: any) => c.stage === 'qualified').length, not_qualified: clients.filter((c: any) => c.stage === 'not_qualified').length,
            current_converted: clients.filter((c: any) => c.stage === 'converted').length, order_created: clients.filter((c: any) => c.stage === 'order_created').length,
            pending: clients.filter((c: any) => !['qualified', 'not_qualified', 'converted', 'order_created'].includes(c.stage)).length, finance: money, clients, orders: co };
    };
    const days = range.days.map(day => {
        const dailyOrders = doneByDay.get(day) || [], closedOrders = closedByDay.get(day) || [], closed = closedOrders.length, done = dailyOrders.length;
        const plans = pageId ? input.page_plans.filter((p: any) => p.work_date === day) : input.team_plans.filter((p: any) => p.work_date === day);
        const target = plans.length ? sum(plans, 'quota') : null;
        const active = plans.length ? sum(plans, pageId ? 'active_workers' : 'participating') : null;
        const unknown = plans.length ? sum(plans, pageId ? 'attendance_unknown' : 'unknown') : null;
        const rate = (input.messages || []).find((m: any) => m.day === day);
        const start = Date.parse(day + 'T00:00:00+08:00');
        const fullCoverage = input.pages.length > 0 && input.pages.every((p: any) => input.message_coverage.some((c: any) => c.page_id === p.id && Date.parse(c.capture_from) <= start));
        const summary = cohort(day);
        const archivedClosed = closedOrders.filter((o: any) => o.financial_source === 'retained').length, archivedDone = dailyOrders.filter((o: any) => o.financial_source === 'retained').length;
        const salaryRates = (finance.salary_days || []).filter((d: any) => d.work_date === day && d.done > 0 && [35, 40].includes(d.rate));
        return { work_date: day, future: day > range.today, before_launch: day < launchDay, provisional: day === range.today, closed, done, archived_closed: archivedClosed, archived_done: archivedDone,
            inquiries: summary.inquiries, cohort_converted: summary.converted, converted_later: summary.converted_later, cohort_finance: summary.finance, cohort_closed: summary.closed, cohort_done: summary.done, cohort_orders_created: summary.created_orders,
            salary_rates: [...new Set<number>(salaryRates.map((d: any) => d.rate))].sort().map(rate => ({ rate, workers: salaryRates.filter((d: any) => d.rate === rate).length,
                totals: salaryRates.filter((d: any) => d.rate === rate).flatMap((d: any) => d.totals.map((t: any) => ({ user_id: d.user_id, ...t }))) })),
            finance: financials(dailyOrders, cashByDay.get(day) || [], spendByDay.get(day) || [], input.pages.length, day < launchDay, currencies),
            created_orders: createdOrderTotals(createdByDay.get(day) || []), orders_created_count: (createdByDay.get(day) || []).length,
            quota: { closed: quotaProgress(closed - archivedClosed, target), done: quotaProgress(done - archivedDone, target) }, staffing: { available: active, unknown, roster: plans.length && !pageId ? sum(plans, 'workers') : null, capacity: plans.length ? sum(plans, pageId ? 'full_capacity' : 'capacity') : null },
            response: { inbound: rate ? Number(rate.inbound) : fullCoverage ? 0 : null, answered: rate ? Number(rate.answered) : fullCoverage ? 0 : null, rate: rate ? ratio(Number(rate.answered), Number(rate.inbound)) : null, coverage_complete: fullCoverage } };
    });
    const selected = cohort(selectedDay), cohortIds = new Set(selected.clients.map((c: any) => c.id));
    const rawClients = (input.selected_clients || []).filter((c: any) => cohortIds.has(c.id));
    const touchpoints = [1, 7, 14, 30].map(day => {
        const mature = selected.clients.filter((c: any) => now - Date.parse(c.inquiry_at) >= day * DAY).length;
        const conversions = selected.clients.filter((c: any) => c.converted_at && Date.parse(c.converted_at) - Date.parse(c.inquiry_at) <= day * DAY).length;
        const paid = selected.clients.filter((c: any) => (byContact.get(c.id) || []).some(o => o.closed_at && Date.parse(o.closed_at) >= Date.parse(c.inquiry_at) && Date.parse(o.closed_at) - Date.parse(c.inquiry_at) <= day * DAY)).length;
        return { day, converted: conversions, conversion_rate: ratio(conversions, selected.inquiries), paid, paid_rate: ratio(paid, selected.inquiries), mature_clients: mature, complete_window: mature === selected.inquiries && mature > 0 };
    });
    const timing = [['Qualified', (c: any) => c.qualified_at], ['Closed / first verified payment', (c: any) => (byContact.get(c.id) || []).map(o => o.closed_at).filter(Boolean).sort()[0]], ['Done / verified full payment', (c: any) => (byContact.get(c.id) || []).map(o => o.done_at).filter(Boolean).sort()[0]]].map(([label, get]: any) => {
        const hours = selected.clients.map((c: any) => get(c) ? (Date.parse(get(c)) - Date.parse(c.inquiry_at)) / 3600000 : null).filter((v: number | null): v is number => v != null && v >= 0);
        return { label, recorded: hours.length, mean_hours: mean(hours), median_hours: median(hours) };
    });
    const salaryDays = (finance.salary_days || []).filter((d: any) => d.work_date === selectedDay);
    const topMembers = (input.employees || []).filter((e: any) => (!e.enrolled_at || dayOf(e.enrolled_at) <= selectedDay) && (!e.departed_at || dayOf(e.departed_at) >= selectedDay)
        || orders.some((o: any) => o.seller_id === e.id && o.financial_source === 'workspace' && (o.done_date === selectedDay || o.closed_date === selectedDay))).map((e: any) => {
        const sellerOrders = orders.filter((o: any) => o.seller_id === e.id && o.financial_source === 'workspace'), salary = salaryDays.find((d: any) => d.user_id === e.id);
        return { ...e, closed: sellerOrders.filter((o: any) => o.closed_date === selectedDay).length, done: sellerOrders.filter((o: any) => o.done_date === selectedDay).length,
            totals: salary?.totals || [], target: salary?.target ?? null, rate: salary?.rate ?? null };
    }).sort((a: any, b: any) => b.done - a.done || b.closed - a.closed || a.name.localeCompare(b.name));
    let rank = 0;
    topMembers.forEach((m: any, i: number) => { if (!i || m.done !== topMembers[i - 1].done || m.closed !== topMembers[i - 1].closed) rank++; m.rank = rank; });
    const clients = selected.clients.map((c: any) => { const values = byContact.get(c.id) || []; return { id: c.id, page_id: c.page_id, name: c.name, inquiry_at: c.inquiry_at, stage: c.stage, converted_at: c.converted_at, closed_at: values.map(v => v.closed_at).filter(Boolean).sort()[0] || null, done_at: values.map(v => v.done_at).filter(Boolean).sort()[0] || null }; });
    const historyClients = rawClients.filter((c: any) => c.customer_message_count != null);
    const projection = cohortProjection(selected.clients, input.peer_lag_hours || [], now);
    const { clients: _, orders: __, ...cohortTotals } = selected;
    const selectedRow = days.find(d => d.work_date === selectedDay);
    if (!selectedRow) throw new Error('Choose a date inside the calendar month');
    return { month, selected_day: selectedDay, generated_at: input.as_of, scope: { role: input.scope.role, launch_at: input.scope.launch_at }, pages: input.pages, days,
        earnings: calendarEarnings(days, launchDay, range.today), created_orders: createdOrderTotals(createdOrders),
        selected: { ...selectedRow, cohort: cohortTotals, clients, touchpoints, timing, demographics: demographics(rawClients), subdemographics: demographicSubgroups(rawClients), objections: objections(rawClients), projection: { ...projection,
            revenue: selected.finance.map((f: any) => ({ currency: f.currency, expected_minor: projection.additional != null && f.mean_order_minor != null ? projection.additional * f.mean_order_minor : null })) },
            top_members: topMembers, salary_days: salaryDays, cohort_response: { clients_with_history: historyClients.length, clients_total: selected.inquiries, rate: ratio(sum(historyClients, 'customer_messages_replied'), sum(historyClients, 'customer_message_count')), latest_source: historyClients.map((c: any) => c.message_history_as_of).filter(Boolean).sort().at(-1) || null } },
        coverage: { missing_inquiry_dates: Number(input.missing_inquiry_dates), message_tracking: input.pages.map((p: any) => ({ page_id: p.id, capture_from: (input.message_coverage || []).find((c: any) => c.page_id === p.id)?.capture_from || null })), financial_scope: 'Verified retained records and new VEO ledger in your seller branch. Historical analytics never create salary or quota entitlements.',
            response_definition: 'Customer messages received on this Philippine date with a Page reply after that message and before that date’s midnight. Includes bot and human Page replies. Daily metadata coverage is shown separately from cohort-history reply rates.',
            demographics: 'Recorded manual details take precedence over saved and evidence-backed extracted answers. Unknown values stay in the percentage denominator; age and gender are never inferred from names or photos.',
            projection: 'Empirical 30-day stage-conversion estimate from earlier cohorts with at least 30 days of observed history. Requires 30 comparable unconverted peers; interval is a 95% Wilson sampling range, not a sales guarantee. Later conversions remain possible after 30 days.' } };
}

/** Financial heat never combines currencies or replaces missing costs with zero. */
export function veoCalendarShade(day: any, metric: string, currency: string): number | null {
    if (day.future) return null;
    if (['net', 'cohort_net'].includes(metric)) {
        const row = (metric === 'cohort_net' ? day.cohort_finance : day.finance)?.find((f: any) => f.currency === currency);
        if (row?.ad_spend_minor === 0 && (row?.spend_usable || row?.spend_complete)) return 0;
        const value = row?.net_minor;
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }
    const cohortMetric = ({ closed: 'cohort_closed', done: 'cohort_done', orders_created_count: 'cohort_orders_created' } as Record<string, string>)[metric] || metric;
    return typeof day[cohortMetric] === 'number' ? day[cohortMetric] : null;
}

/** Keep tile amounts and shading on the same attribution basis. */
export function veoCalendarTile(day: any, metric: string) {
    const inquiry = metric !== 'net';
    return { inquiry, closed: inquiry ? day.cohort_closed ?? 0 : day.closed,
        done: inquiry ? day.cohort_done ?? 0 : day.done,
        orders: inquiry ? day.cohort_orders_created ?? 0 : day.created_orders?.count ?? 0,
        finance: inquiry ? day.cohort_finance || [] : day.finance || [] };
}
