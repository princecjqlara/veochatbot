import { requestDeadline, DatabaseReadTimeout } from './request-deadline';
const DAY = 86400000;
const shift = (s: string, n: number) => new Date(Date.parse(s + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const pht = (s: string) => new Date(Date.parse(s) + 8 * 3600000).toISOString().slice(0, 10);
type Job = { page: string; from: string; to: string };
/** Disjoint Pages, then date bisection on SQL timeout. Failed pieces never
 * become an empty or partially successful all-Page financial report. */
export async function loadVeoCalendarInputs(db: any, actor: string, pageIds: string[], from: string, to: string, day: string) {
    const jobs: Job[] = [...new Set(pageIds)].map(page => ({ page, from, to })), replies: Array<{ job: Job; data: any }> = [];
    const deadline = Date.now() + 95000; let cursor = 0, failure: any = null;
    if (!jobs.length) throw new Error('No assigned Pages are available');
    async function worker() {
        while (!failure && cursor < jobs.length) {
            const job = jobs[cursor++];
            try {
                const left = deadline - Date.now(); if (left <= 0) throw Object.assign(new Error('Calendar report deadline reached. Retry shortly.'), { status: 503 });
                const selected = day >= job.from && day <= job.to ? day : job.from;
                let reply: any;
                try { reply = await requestDeadline(signal => {
                    const q = db.rpc('veo_calendar_inputs', { p_actor: actor, p_from: job.from, p_to: job.to, p_day: selected, p_page: job.page });
                    return typeof q?.abortSignal === 'function' ? q.abortSignal(signal) : q;
                }, Math.min(20000, left)); }
                catch (e) { if (e instanceof DatabaseReadTimeout) reply = { error: { code: '57014' } }; else throw e; }
                if (reply?.error?.code === '57014' && job.from < job.to) {
                    const count = Math.round((Date.parse(job.to) - Date.parse(job.from)) / DAY), middle = shift(job.from, Math.floor(count / 2));
                    jobs.push({ ...job, to: middle }, { ...job, from: shift(middle, 1) }); continue;
                }
                if (reply?.error || !reply?.data || !['leads', 'orders', 'cash', 'pages'].every(k => Array.isArray(reply.data[k]))) throw Object.assign(new Error('A calendar data slice could not be completed'), { status: reply?.error?.code === '42501' ? 403 : 503 });
                replies.push({ job, data: reply.data });
            } catch (e) { failure = e; }
        }
    }
    await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, worker));
    if (failure) throw failure;
    const maps = Object.fromEntries(['leads', 'selected_clients', 'orders', 'cash', 'spend', 'messages', 'message_coverage', 'page_plans', 'team_plans', 'employees', 'pages'].map(k => [k, new Map<string, any>()]));
    const keys: Record<string, (r: any) => any> = { leads: r => r.id, selected_clients: r => r.id, orders: r => r.order_key,
        cash: r => [r.contact_id, r.page_id, r.currency, r.paid_day, r.source], spend: r => [r.page_id, r.spend_date, r.currency],
        messages: r => r.day, message_coverage: r => r.page_id, page_plans: r => [r.team_id, r.page_id, r.work_date], team_plans: r => [r.team_id, r.work_date], employees: r => r.id, pages: r => r.id };
    const pageMissing = new Map<string, number>(), dailyMessages = new Map<string, any>(), peers: any[] = [];
    replies.sort((a, b) => String(a.data.as_of).localeCompare(String(b.data.as_of)));
    for (const { job, data } of replies) {
        pageMissing.set(job.page, Math.max(pageMissing.get(job.page) || 0, Number(data.missing_inquiry_dates || 0)));
        if (day >= job.from && day <= job.to) peers.push(...(data.peer_lag_hours || []));
        for (const field of Object.keys(maps)) for (const r of data[field] || []) {
            if (field === 'selected_clients' && pht(r.inquiry_at) !== day) continue;
            if (field === 'messages') { dailyMessages.set(`${job.page}:${r.day}`, r); continue; }
            maps[field].set(JSON.stringify(keys[field](r)), r);
        }
    }
    const messages = new Map<string, any>();
    for (const r of dailyMessages.values()) { const value = messages.get(r.day) || { day: r.day, inbound: 0, answered: 0 }; value.inbound += Number(r.inbound); value.answered += Number(r.answered); messages.set(r.day, value); }
    return { ...replies[replies.length - 1].data, ...Object.fromEntries(Object.entries(maps).map(([key, rows]) => [key, [...rows.values()]])), selected_day: day,
        messages: [...messages.values()], peer_lag_hours: peers, missing_inquiry_dates: [...pageMissing.values()].reduce((a, b) => a + b, 0), completed_slices: replies.length };
}
