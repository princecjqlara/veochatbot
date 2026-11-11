'use client';
import VeoWorkforceReadiness from './VeoWorkforceReadiness';
const number = (value: number | null | undefined) => value == null ? 'Unavailable' : new Intl.NumberFormat('en-PH', { maximumFractionDigits: 2 }).format(value);

export function VeoCapacityMetrics({ metrics, title, compact = false }: { metrics: any; title: string; compact?: boolean }) {
    const history = metrics.history, tomorrow = metrics.tomorrow;
    return <section className="space-y-4" aria-label={title}>
        <h2 className="font-bold text-lg">{title}</h2>
        <div className="grid gap-3 sm:grid-cols-3">
            <p className="rounded bg-slate-50 p-3 text-sm">Combined daily capacity<strong className="block text-2xl">{metrics.capacity}</strong>deals per day</p>
            <p className="rounded bg-slate-50 p-3 text-sm">Average capacity per worker<strong className="block text-2xl">{number(metrics.average_worker_capacity)}</strong>deals per day</p>
            <p className="rounded bg-slate-50 p-3 text-sm">Selling workers<strong className="block text-2xl">{metrics.workers}</strong>includes selling managers</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">{[['closed', 'Closed Deals'], ['done', 'Done Deals']].map(([key, label]) => <div key={key} className="rounded border p-3 text-sm">
            <p>{label} / team quota</p><p className="text-2xl font-bold">{metrics[key]} / {metrics.quota[key]}</p>
            {metrics.quota[key] > 0 ? <><progress className="w-full mt-2" aria-label={`${label} team progress`} value={Math.min(metrics[key], metrics.quota[key])} max={metrics.quota[key]} /><p>{number(metrics.quota[`${key}_percent`])}% reached</p></> : <p>No active workers declared for this date.</p>}
        </div>)}</div>
        <p className="text-sm font-semibold">{metrics.quota.met ? 'Both team quotas reached' : metrics.quota.closed > 0 ? 'Team quotas still in progress' : 'Team quota awaits active participation'}</p>
        <p className="text-sm text-slate-600">{metrics.participating} participating workers · {metrics.attendance_unknown} without a declaration for this work date.</p>
        <div className="grid gap-3 sm:grid-cols-2 text-sm">
            <p>Combined team daily average<strong className="block text-lg">{number(history.average_done_per_day)} Done Deals / day</strong>{history.completed_days} completed Philippine dates{history.period_start && ` (${history.period_start} to ${history.period_end})`}; zero-output dates included.</p>
            <p>Best-three team days average<strong className="block text-lg">{history.best_three_average == null ? `Insufficient history (${history.best_days_count}/3 days)` : `${number(history.best_three_average)} Done Deals / day`}</strong>Within the previous 14 completed dates since launch.</p>
        </div>
        <div className="rounded bg-slate-50 p-3 text-sm"><p className="font-semibold">Tomorrow ({tomorrow.work_date})</p><p>{tomorrow.active} active · team quota {tomorrow.capacity} Closed and {tomorrow.capacity} Done Deals</p><p>Average active-worker capacity: {number(tomorrow.average_active_capacity)} · {tomorrow.inactive} inactive · {tomorrow.unknown} awaiting declaration</p><p>Full-team potential: {tomorrow.full_capacity} deals per day</p></div>
        {!compact && <p className="text-xs text-slate-500">Team quotas add the declared active workers’ frozen individual targets. Full capacity includes all selling workers. Today’s team plan includes staff added today; completed team days stay fixed. Tomorrow’s declarations change tomorrow’s plan. Results and historical averages include your currently assigned Pages. Each worker earns 40% when both personal Closed and Done Deal quotas are reached; otherwise they earn 35%. Team results do not change a worker’s individual rate. The final rate applies to all fully paid order totals for that Philippine date.</p>}
    </section>;
}

export default function VeoCapacitySummary({ capacity, personal }: { capacity: any; personal?: any }) {
    if (!capacity?.combined) return <p role="status" className="rounded border bg-white p-5">Team capacity is unavailable. Refresh to retry.</p>;
    return <div className="space-y-5">
        <VeoWorkforceReadiness readiness={capacity.workforce_readiness} />
        {personal && <section className="rounded border bg-white p-5"><h2 className="font-bold text-xl">Your individual quota</h2><p className="mt-2">Closed Deals {personal.closed} / {personal.operating_quota ?? personal.target} · Done Deals {personal.done} / {personal.operating_quota ?? personal.target}</p><p className="text-sm text-slate-600">Proven production capacity: {personal.production_capacity ?? personal.target}. Operating quota: {personal.operating_quota ?? personal.target}. Commission qualification target: {personal.target}. Your personal commission rate is {personal.rate}%{personal.provisional ? ' (provisional)' : ''}.</p>{personal.quota_basis && <p className="text-sm mt-2">Ads: {personal.quota_basis.ad_mode.replaceAll('_', ' ')} · {personal.quota_basis.open_paid_clients} existing paid clients · {personal.quota_basis.funded_new_clients} estimated funded clients. This day’s quota is frozen; later ad changes affect the next day. Unknown or lifetime budgets keep the capacity target.</p>}<p className="mt-2 font-semibold">{personal.rate === 40 ? 'Both personal quotas reached: 40% commission.' : `35% commission. To reach 40%: ${Math.max(0, personal.target - personal.closed)} more Closed and ${Math.max(0, personal.target - personal.done)} more Done Deals.`}</p>{personal.operating_quota === 0 && <p className="text-xs mt-2">No funded or existing work was recorded at the daily snapshot. No salary is created from a zero quota. If a sale is completed, at least one verified Closed and Done Deal is required for 40%.</p>}{personal.provisional && <p className="text-xs text-slate-500">Earnings remain provisional until midnight in the Philippines. Your final daily rate applies to all fully paid order totals for that date.</p>}</section>}
        <div className="rounded border bg-white p-5"><VeoCapacityMetrics metrics={capacity.combined} title={capacity.teams.length === 1 ? `Team capacity and quotas — ${capacity.teams[0].name}` : `Combined capacity and quotas — ${capacity.teams.length} teams`} /></div>
        {capacity.teams.length > 1 && <section className="rounded border bg-white p-5 overflow-x-auto"><h2 className="font-bold text-xl mb-3">Team comparison</h2><table className="w-full text-left text-sm"><thead><tr>{['Team', 'Workers', 'Capacity / day', 'Average / worker', 'Closed / quota', 'Done / quota', 'Historical DD / day', 'Tomorrow’s quota'].map(t => <th key={t} className="border-b p-3">{t}</th>)}</tr></thead><tbody>{capacity.teams.map((team: any) => <tr key={team.id}><td className="border-b p-3">{team.name}</td><td className="border-b p-3">{team.workers}</td><td className="border-b p-3">{team.capacity}</td><td className="border-b p-3">{number(team.average_worker_capacity)}</td><td className="border-b p-3">{team.closed} / {team.quota.closed}</td><td className="border-b p-3">{team.done} / {team.quota.done}</td><td className="border-b p-3">{number(team.history.average_done_per_day)}</td><td className="border-b p-3">{team.tomorrow.capacity} each</td></tr>)}</tbody></table></section>}
    </div>;
}
