const number = (value: unknown) => Number(value || 0);
const average = (value: number, days: number) => days ? value / days : null;
const sum = (rows: any[], field: string) => rows.reduce((total, row) => total + number(row[field]), 0);
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Read-only analytics. A missing cost never becomes a free cost; today and
 * dates outside the existing employment frames never dilute final averages. */
export function buildStaffPerformance(input: any) {
    const extra = input.performance_inputs;
    if (extra?.version !== 1) return null;
    const today = new Date(Date.parse(input.as_of) + 8 * 3600000).toISOString().slice(0, 10);
    const currencies = [...new Set<string>([
        ...(input.days || []).flatMap((day: any) => (day.totals || []).map((total: any) => total.currency)),
        ...(extra.ad_costs || []).map((cost: any) => cost.currency)
    ])].sort();
    const clients = new Map((extra.new_clients || []).map((day: any) => [day.work_date, number(day.new_clients)]));
    const costs = new Map((extra.ad_costs || []).map((cost: any) => [`${cost.work_date}:${cost.currency}`, cost]));
    const days = (input.days || []).map((day: any) => ({
        work_date: day.work_date, provisional: day.work_date >= today,
        closed: number(day.closed), done: number(day.done), new_clients: clients.get(day.work_date) || 0,
        attendance: day.attendance?.active ?? null,
        reply_rate: number(day.replies?.incoming_clients) ? number(day.replies?.answered_clients) / number(day.replies.incoming_clients) : null,
        finance: currencies.map(currency => {
            const total = (day.totals || []).find((row: any) => row.currency === currency);
            const cost: any = costs.get(`${day.work_date}:${currency}`);
            const gross = number(total?.order_gross_minor), revenue = number(total?.gross_minor), salary = number(total?.commission_minor);
            const adCost = cost?.ad_cost_minor == null ? null : Number(cost.ad_cost_minor);
            return { currency, gross_minor: gross, revenue_minor: revenue, salary_minor: salary,
                gross_profit_minor: revenue - salary, ad_cost_minor: adCost,
                net_profit_minor: adCost == null ? null : revenue - salary - adCost,
                cost_pages_known: number(cost?.pages_known), cost_pages_expected: number(cost?.pages_expected) };
        })
    })).sort((a: any, b: any) => a.work_date.localeCompare(b.work_date));
    const completed = days.filter((day: any) => !day.provisional);
    function totals(rows: any[]) {
        return currencies.map(currency => {
            const values = rows.map(day => day.finance.find((row: any) => row.currency === currency));
            const known = values.filter(row => row?.net_profit_minor != null).length;
            const cost = rows.length && known === rows.length ? sum(values, 'ad_cost_minor') : null;
            const net = cost == null ? null : sum(values, 'gross_profit_minor') - cost;
            return { currency, gross_minor: sum(values, 'gross_minor'), revenue_minor: sum(values, 'revenue_minor'), salary_minor: sum(values, 'salary_minor'),
                gross_profit_minor: sum(values, 'gross_profit_minor'), ad_cost_minor: cost, net_profit_minor: net,
                average_gross_minor: average(sum(values, 'gross_minor'), rows.length),
                average_salary_minor: average(sum(values, 'salary_minor'), rows.length),
                average_gross_profit_minor: average(sum(values, 'gross_profit_minor'), rows.length),
                average_net_profit_minor: net == null ? null : average(net, rows.length),
                cost_known_days: known, cost_missing_days: rows.length - known };
        });
    }
    const byWeekday = weekdays.map((name, index) => {
        const rows = completed.filter((day: any) => new Date(day.work_date + 'T00:00:00Z').getUTCDay() === index);
        return { name, index, days: rows.length, closed: sum(rows, 'closed'), done: sum(rows, 'done'), new_clients: sum(rows, 'new_clients'),
            average_closed: average(sum(rows, 'closed'), rows.length), average_done: average(sum(rows, 'done'), rows.length),
            average_new_clients: average(sum(rows, 'new_clients'), rows.length), finance: totals(rows) };
    });
    const bestWeekday = byWeekday.filter(day => day.days && day.closed + day.done > 0)
        .sort((a, b) => number(b.average_done) - number(a.average_done) || number(b.average_closed) - number(a.average_closed) || a.index - b.index)[0] || null;
    const bestDates = [...completed].filter((day: any) => day.done + day.closed > 0)
        .sort((a: any, b: any) => b.done - a.done || b.closed - a.closed || b.work_date.localeCompare(a.work_date)).slice(0, 5);
    return { version: 1, currencies, days, weekdays: byWeekday, best_weekday: bestWeekday, best_dates: bestDates,
        completed_days: completed.length, sales_days: completed.filter((day: any) => day.closed + day.done > 0).length,
        zero_sales_days: completed.filter((day: any) => day.closed + day.done === 0).length,
        average_closed: average(sum(completed, 'closed'), completed.length), average_done: average(sum(completed, 'done'), completed.length),
        average_new_clients: average(sum(completed, 'new_clients'), completed.length), new_clients: sum(days, 'new_clients'),
        current_clients: number(extra.current_clients), ever_assigned_clients: number(extra.ever_assigned_clients), clients_with_sales: number(extra.clients_with_sales),
        totals: totals(days), completed_totals: totals(completed),
        overall_ranking: extra.overall_ranking, page_rankings: extra.page_rankings || [],
        cd_turnaround: extra.cd_turnaround, video_turnaround: extra.video_turnaround, cost_model: extra.cost_model };
}
