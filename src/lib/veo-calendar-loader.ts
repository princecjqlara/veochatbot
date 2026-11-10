import { requestDeadline, DatabaseReadTimeout } from './request-deadline';
const DAY = 86400000;
const shift = (s: string, n: number) => new Date(Date.parse(s + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const pht = (s: string) => new Date(Date.parse(s) + 8 * 3600000).toISOString().slice(0, 10);
type Job = { page: string; from: string; to: string; retried?: boolean };
type ReadOptions = { allPages?: boolean };
const requiredArrays = ['leads', 'selected_clients', 'orders', 'created_orders', 'cash', 'spend', 'messages', 'message_coverage', 'page_plans', 'team_plans', 'employees', 'pages', 'peer_lag_hours'];
const completeInput = (data: any) => data && requiredArrays.every(k => Array.isArray(data[k]));
const maySplit = (error: any) => ['57014', 'REPORT_BATCH_BUDGET'].includes(error?.code) || error?.message === 'Select one Page to complete this calendar';
const unavailable = (error?: any) => Object.assign(new Error('A complete calendar read is temporarily unavailable'), { status: error?.code === '42501' ? 403 : 503 });
const cooldown = (error: any) => error?.code === '57014' ? new Promise(resolve => setTimeout(resolve, 2100)) : Promise.resolve();
async function rpcRead(db: any, name: string, args: any, milliseconds: number, parent?: AbortSignal) {
    return requestDeadline<any>(signal => {
        const q = db.rpc(name, args);
        return typeof q?.abortSignal === 'function' ? q.abortSignal(signal) : q;
    }, milliseconds, parent);
}
async function combinedRead(db: any, name: string, args: any, pages: string[], milliseconds: number) {
    try { return await rpcRead(db, name, args, milliseconds); }
    catch (error) {
        if (!(error instanceof DatabaseReadTimeout)) throw error;
        // A large combined query must not make an otherwise readable report
        // permanently unavailable. Confirm live DB/scope health before slicing.
        await cooldown({ code: '57014' });
        const probe = await rpcRead(db, 'veo_scope', { p_actor: args.p_actor }, 5000);
        if (probe?.error || !probe?.data?.launch_at || !Array.isArray(probe.data.page_ids)) throw unavailable(probe?.error);
        const current = new Set(probe.data.page_ids);
        if (current.size !== pages.length || pages.some(page => !current.has(page))) throw Object.assign(new Error('Calendar Page access changed; refresh the report'), { status: 403 });
        return { error: { code: 'REPORT_BATCH_BUDGET' } };
    }
}
/** Disjoint Pages, then date bisection on SQL timeout. Failed pieces never
 * become an empty or partially successful all-Page financial report. */
export async function loadVeoCalendarInputs(db: any, actor: string, pageIds: string[], from: string, to: string, day: string | null, options: ReadOptions = {}) {
    const jobs: Job[] = [...new Set(pageIds)].map(page => ({ page, from, to })), replies: Array<{ job: Job; data: any }> = [];
    const deadline = Date.now() + 60000, cancel = new AbortController(); let cursor = 0, failure: any = null;
    if (!jobs.length) throw new Error('No assigned Pages are available');
    // Only the caller that requests the entire live authorized scope may use
    // NULL. Explicit subsets keep their Page filters and never broaden scope.
    if (options.allPages && jobs.length > 1) {
        const reply = await combinedRead(db, 'veo_calendar_inputs', { p_actor: actor, p_from: from, p_to: to, p_day: day, p_page: null }, jobs.map(j => j.page), 5000);
        if (!reply || (!reply.data && !reply.error)) throw unavailable();
        if (!reply.error) {
            if (!completeInput(reply.data)) throw unavailable();
            const actual = new Set(reply.data.pages.map((p: any) => p.id));
            if (actual.size !== jobs.length || reply.data.pages.length !== jobs.length || jobs.some(j => !actual.has(j.page))) throw Object.assign(new Error('Calendar Page coverage changed; refresh the report'), { status: 503 });
            return { ...reply.data, completed_slices: 1 };
        }
        if (!maySplit(reply.error)) throw unavailable(reply.error);
        // A SQL timeout completed on the server. Let the availability gate's
        // short cooldown finish before starting the smaller bounded reads.
        await cooldown(reply.error);
    }
    async function worker() {
        while (!failure && cursor < jobs.length) {
            const job = jobs[cursor++];
            try {
                const left = deadline - Date.now(); if (left <= 0) throw Object.assign(new Error('Calendar report deadline reached. Retry shortly.'), { status: 503 });
                const selected = day == null ? null : day >= job.from && day <= job.to ? day : job.from;
                let reply: any;
                try { reply = await rpcRead(db, 'veo_calendar_inputs', { p_actor: actor, p_from: job.from, p_to: job.to, p_day: selected, p_page: job.page }, Math.min(20000, left), cancel.signal); }
                catch (e) { if (e instanceof DatabaseReadTimeout) reply = { error: { code: '57014' } }; else throw e; }
                if (reply?.error?.code === '57014' && !job.retried) {
                    // Let other Pages complete before retrying this exact read.
                    // Temporary shared-database load must not immediately multiply
                    // the number of date slices and amplify the same contention.
                    jobs.push({ ...job, retried: true }); continue;
                }
                if (maySplit(reply?.error) && job.from < job.to) {
                    const count = Math.round((Date.parse(job.to) - Date.parse(job.from)) / DAY), middle = shift(job.from, Math.floor(count / 2));
                    jobs.push({ page: job.page, from: job.from, to: middle }, { page: job.page, from: shift(middle, 1), to: job.to }); continue;
                }
                if (reply?.error || !completeInput(reply?.data)) throw Object.assign(new Error('A calendar data slice could not be completed'), { status: reply?.error?.code === '42501' ? 403 : 503 });
                replies.push({ job, data: reply.data });
            } catch (e) { if (!failure) failure = e; cancel.abort(e); }
        }
    }
    await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, worker));
    if (failure) throw failure;
    const maps = Object.fromEntries(['leads', 'selected_clients', 'orders', 'created_orders', 'cash', 'spend', 'messages', 'message_coverage', 'page_plans', 'team_plans', 'employees', 'pages'].map(k => [k, new Map<string, any>()]));
    const keys: Record<string, (r: any) => any> = { leads: r => r.id, selected_clients: r => r.id, orders: r => r.order_key, created_orders: r => r.order_key,
        cash: r => [r.contact_id, r.page_id, r.currency, r.paid_day, r.source], spend: r => [r.page_id, r.spend_date, r.currency],
        messages: r => r.day, message_coverage: r => r.page_id, page_plans: r => [r.team_id, r.page_id, r.work_date], team_plans: r => [r.team_id, r.work_date], employees: r => r.id, pages: r => r.id };
    const pageMissing = new Map<string, number>(), dailyMessages = new Map<string, any>(), peers: any[] = [];
    replies.sort((a, b) => String(a.data.as_of).localeCompare(String(b.data.as_of)));
    for (const { job, data } of replies) {
        pageMissing.set(job.page, Math.max(pageMissing.get(job.page) || 0, Number(data.missing_inquiry_dates || 0)));
        if (day != null && day >= job.from && day <= job.to) peers.push(...(data.peer_lag_hours || []));
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

export async function loadVeoCalendarDetails(db: any, actor: string, pageIds: string[], day: string, options: ReadOptions = {}) {
    const pages = [...new Set(pageIds)], replies: any[] = [], deadline = Date.now() + 30000, cancel = new AbortController(); let index = 0, failed = false;
    if (!pages.length) throw new Error('No assigned Pages are available');
    if (options.allPages && pages.length > 1) {
        const reply = await combinedRead(db, 'veo_calendar_day_details', { p_actor: actor, p_day: day, p_page: null }, pages, 4000);
        if (!reply || (!reply.data && !reply.error)) throw unavailable();
        if (!reply.error) {
            if (reply.data?.selected_day !== day || !Array.isArray(reply.data?.selected_clients) || !Array.isArray(reply.data?.peer_lag_hours) || reply.data.selected_clients.some((c: any) => !pages.includes(c.page_id))) throw unavailable();
            return reply.data;
        }
        if (!maySplit(reply.error)) throw unavailable(reply.error);
        await cooldown(reply.error);
    }
    async function worker() {
        while (!failed && index < pages.length) {
            const page = pages[index++];
            try {
                if (Date.now() >= deadline) throw Object.assign(new Error('Selected day deadline reached'), { status: 503 });
                const result = await rpcRead(db, 'veo_calendar_day_details', { p_actor: actor, p_day: day, p_page: page }, Math.min(15000, deadline - Date.now()), cancel.signal);
                if (result.error || !Array.isArray(result.data?.selected_clients) || !Array.isArray(result.data?.peer_lag_hours)) throw Object.assign(new Error('Selected day details are temporarily unavailable'), { status: result.error?.code === '42501' ? 403 : 503 });
                replies.push(result.data);
            } catch (error) { failed = true; cancel.abort(error); throw error; }
        }
    }
    await Promise.all(Array.from({ length: Math.min(2, pages.length) }, worker));
    return { selected_clients: replies.flatMap(r => r.selected_clients), peer_lag_hours: replies.flatMap(r => r.peer_lag_hours), selected_day: day };
}
