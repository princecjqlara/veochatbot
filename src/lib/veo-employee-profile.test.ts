import { expect, it } from 'vitest';
import { buildEmployeeProfile } from './veo-employee-profile';
const input = () => ({
    as_of: '2026-11-07T16:00:00Z', from: '2026-11-06', to: '2026-11-08', capacity: { best_days: [{ n: 5 }, { n: 4 }, { n: 3 }] },
    summary: { cd_cohort: 4, cd_cohort_done: 3, assigned_cohort: 5, assigned_cohort_converted: 2, reply_client_days: 3, answered_client_days: 1 },
    reply_coverage: { pages: [{ capture_from: '2026-11-05T00:00:00Z' }] },
    days: [
        { work_date: '2026-11-06', attendance: { active: true }, totals: [{ currency: 'PHP', order_gross_minor: 10000, gross_minor: 8000, commission_minor: 3200 }] },
        { work_date: '2026-11-07', attendance: null, totals: [] },
        { work_date: '2026-11-08', attendance: { active: false }, totals: [{ currency: 'PHP', order_gross_minor: 6000, gross_minor: 6000, commission_minor: 2100 }, { currency: 'USD', order_gross_minor: 100, gross_minor: 100, commission_minor: 35 }] }
    ]
});
it('includes completed zero-sales dates and excludes today at exactly Philippine midnight from averages', () => {
    const p = buildEmployeeProfile(input());
    expect(p.completed_days).toBe(2); expect(p.active_completed_days).toBe(1);
    expect(p.totals[0]).toMatchObject({ currency: 'PHP', gross_minor: 16000, net_minor: 14000, salary_minor: 5300, average_daily_gross_minor: 5000, average_daily_net_minor: 4000, average_daily_salary_minor: 1600, average_active_day_salary_minor: 3200, provisional_salary_minor: 2100 });
    expect(p.totals[1]).toMatchObject({ currency: 'USD', average_daily_gross_minor: 0, average_daily_salary_minor: 0, provisional_salary_minor: 35 });
    expect(p.attendance).toEqual({ active: 1, inactive: 1, unknown: 1 });
    expect(p.capacity.best_day_average).toBe(4);
});
it('keeps currencies separate and returns unknown instead of invented rates on empty denominators', () => {
    const p = input(); p.summary = { cd_cohort: 0, cd_cohort_done: 0, assigned_cohort: 0, assigned_cohort_converted: 0, reply_client_days: 0, answered_client_days: 0 };
    const r = buildEmployeeProfile({ ...p, days: [p.days[2]] });
    expect(r.completed_days).toBe(0); expect(r.totals[0].average_daily_salary_minor).toBeNull();
    expect(r.summary).toMatchObject({ cd_to_dd_rate: null, conversion_rate: null, reply_rate: null });
});
it('reports partial capture and open reply windows independently from observed personal replies', () => {
    const p = input(); p.reply_coverage.pages[0].capture_from = '2026-11-06T10:00:00Z';
    const r = buildEmployeeProfile(p);
    expect(r.reply_coverage).toMatchObject({ complete: false, recent_window_provisional: true });
    expect(r.summary).toMatchObject({ cd_to_dd_rate: 0.75, conversion_rate: 0.4, reply_rate: 1 / 3 });
});
