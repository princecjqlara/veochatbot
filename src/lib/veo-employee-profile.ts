import { buildStaffPerformance } from './veo-staff-performance';
const ratio = (n: number, d: number) => d > 0 ? n / d : null;
const sum = (rows: any[], key: string) => rows.reduce((n, row) => n + Number(row[key] || 0), 0);

/** Averages include every eligible completed employment date, including zero-sales
 * dates. Today is reported separately; currencies and Page commission shares stay
 * separate. No personal attribution is inferred from shared Page access. */
export function buildEmployeeProfile(input: any) {
    const { performance_inputs: _performanceInputs, ...publicInput } = input;
    const today = new Date(Date.parse(input.as_of) + 8 * 3600000).toISOString().slice(0, 10);
    const days: any[] = input.days || [], completed = days.filter(d => d.work_date < today);
    const active = completed.filter(d => d.attendance?.active === true);
    const currencies = [...new Set<string>(days.flatMap(d => d.totals.map((t: any) => t.currency)))].sort();
    const totals = currencies.map(currency => {
        const amounts = (rows: any[]) => rows.flatMap(d => d.totals.filter((t: any) => t.currency === currency));
        const all = amounts(days), final = amounts(completed), declared = amounts(active);
        return {
            currency, gross_minor: sum(all, 'order_gross_minor'), net_minor: sum(all, 'gross_minor'), salary_minor: sum(all, 'commission_minor'),
            average_daily_gross_minor: ratio(sum(final, 'order_gross_minor'), completed.length),
            average_daily_net_minor: ratio(sum(final, 'gross_minor'), completed.length),
            average_daily_salary_minor: ratio(sum(final, 'commission_minor'), completed.length),
            average_active_day_salary_minor: ratio(sum(declared, 'commission_minor'), active.length),
            provisional_gross_minor: sum(amounts(days.filter(d => d.work_date === today)), 'order_gross_minor'),
            provisional_salary_minor: sum(amounts(days.filter(d => d.work_date === today)), 'commission_minor')
        };
    });
    const s = input.summary;
    const pages: any[] = input.reply_coverage?.pages || [];
    const start = Date.parse(input.from + 'T00:00:00+08:00');
    const replyCoverageComplete = pages.length > 0 && pages.every(p => p.capture_from && Date.parse(p.capture_from) <= start);
    const best = (input.capacity.best_days || []).map((d: any) => Number(d.n));
    return {
        ...publicInput, totals, performance: buildStaffPerformance(input), completed_days: completed.length, active_completed_days: active.length,
        attendance: { active: days.filter(d => d.attendance?.active === true).length, inactive: days.filter(d => d.attendance?.active === false).length, unknown: days.filter(d => d.attendance == null).length },
        capacity: { ...input.capacity, best_day_average: best.length ? best.reduce((a: number, b: number) => a + b, 0) / best.length : null },
        summary: { ...s, cd_to_dd_rate: ratio(Number(s.cd_cohort_done), Number(s.cd_cohort)),
            conversion_rate: ratio(Number(s.assigned_cohort_converted), Number(s.assigned_cohort)),
            reply_rate: ratio(Number(s.answered_client_days), Number(s.reply_client_days)) },
        reply_coverage: { ...input.reply_coverage, complete: replyCoverageComplete, recent_window_provisional: input.to >= new Date(Date.parse(input.as_of) - 86400000 + 8 * 3600000).toISOString().slice(0, 10) }
    };
}
