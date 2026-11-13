import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it } from 'vitest';
import Summary, { VeoCapacityMetrics } from './VeoCapacitySummary';
const metrics = {
    workers: 3, capacity: 12, average_worker_capacity: 4, participating: 2, attendance_unknown: 1, closed: 5, done: 4,
    quota: { closed: 8, done: 8, closed_percent: 62.5, done_percent: 50, met: false },
    history: { average_done_per_day: 2.5, completed_days: 14, period_start: '2026-11-01', period_end: '2026-11-14', best_three_average: 6, best_days_count: 3 },
    tomorrow: { work_date: '2026-11-16', active: 1, inactive: 1, unknown: 1, capacity: 3, full_capacity: 11, average_active_capacity: 3 }
};
const flatten = (v: any): string => typeof v === 'string' || typeof v === 'number' ? String(v) : (v?.children || []).map(flatten).join('');
it('shows team quotas separately from full capacity, historical average and an individual commission target', async () => {
    let view: any; await act(async () => { view = create(createElement(Summary, { capacity: { combined: metrics, teams: [{ id: 'team', name: 'VEO A', ...metrics }] }, personal: { closed: 0, done: 1, target: 1, rate: 35, provisional: true } })); });
    try {
        const text = flatten(view.toJSON());
        for (const title of ['Your individual quota', 'Combined daily capacity', 'Average capacity per worker', 'Combined team daily average', 'Best-three team days average']) expect(text).toContain(title);
        expect(text).toContain('35%'); expect(text).toContain('5 / 8'); expect(text).toContain('4 / 8');
        expect(text).toContain('To reach 40%: 1 more Closed and 0 more Done Deals');
        expect(text).toContain('otherwise they earn 35%');
        expect(text).toContain('team quota 3 Closed and 3 Done Deals'); expect(text).toContain('zero-output dates included');
        expect(view.root.findAllByType('progress').map((p: any) => [p.props.value, p.props.max])).toEqual([[5,8],[4,8]]);
    } finally { await act(async () => view.unmount()); }
});
it('shows unavailable averages and undeclared participation without claiming a zero target was met', async () => {
    let view: any; await act(async () => { view = create(createElement(VeoCapacityMetrics, { metrics: { ...metrics, capacity: 0, workers: 0, participating: 0, average_worker_capacity: null,
        quota: { closed: 0, done: 0, met: false }, history: { ...metrics.history, average_done_per_day: null, completed_days: 0, best_three_average: null, best_days_count: 0 } }, title: 'Empty team' })); });
    try { const text = flatten(view.toJSON()); expect(text).toContain('Unavailable'); expect(text).toContain('Insufficient history'); expect(text).toContain('quota awaits active participation'); expect(view.root.findAllByType('progress')).toHaveLength(0); }
    finally { await act(async () => view.unmount()); }
});
