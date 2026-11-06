'use client';
import { useState } from 'react';
import Link from 'next/link';
const money = (n: number, currency: string) => new Intl.NumberFormat('en-PH', { style: 'currency', currency }).format(n / 100);
export default function VeoTeamsDashboard({ data, busy, onAttendance }: { data: any; busy: boolean; onAttendance: (userId: string, active: boolean) => void }) {
    const [leader, setLeader] = useState('');
    const leaders = data.accounts.filter((a: any) => a.role === 'team_leader');
    const teams = data.teams.filter((t: any) => !leader || data.accounts.find((a: any) => a.id === t.manager_id)?.parent_id === leader);
    return <section className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">{[['Team leaders', leaders.length], ['Teams', data.teams.length], ['Selling workers', data.accounts.filter((a: any) => ['manager', 'member'].includes(a.role)).length]].map(([title, count]) => <div key={title} className="rounded border bg-white p-5"><p className="text-sm text-slate-500">{title}</p><p className="text-3xl font-bold mt-2">{count}</p></div>)}</div>
        <div className="flex flex-wrap justify-between gap-3 items-center"><h2 className="text-xl font-bold">Team results and tomorrow’s plan</h2><label className="text-sm">Team leader<select className="border rounded p-2 ml-2" value={leader} onChange={e => setLeader(e.target.value)}><option value="">All branches</option>{leaders.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label></div>
        {!teams.length && <div className="rounded border bg-white p-6"><p>No teams in this branch yet.</p><Link className="inline-block underline mt-3" href="/dashboard/workspace?view=accounts">Create team leaders, managers and members in Accounts &amp; Teams</Link></div>}
        <div className="grid gap-5 xl:grid-cols-2">{teams.map((team: any) => {
            const manager = data.accounts.find((a: any) => a.id === team.manager_id);
            const head = data.accounts.find((a: any) => a.id === manager?.parent_id);
            const workers = data.accounts.filter((a: any) => a.id === team.manager_id || a.parent_id === team.manager_id);
            const ids = new Set(workers.map((a: any) => a.id)), salary = data.salary.filter((s: any) => ids.has(s.user_id));
            const tomorrow = data.tomorrow.filter((w: any) => ids.has(w.user_id) && w.active === true);
            const totals: Record<string, number> = {};
            for (const s of salary) for (const t of s.totals) totals[t.currency] = (totals[t.currency] || 0) + Number(t.commission_minor);
            return <article key={team.id} className="rounded border bg-white p-5 space-y-4"><div><h3 className="text-xl font-bold">{team.name}</h3><p className="text-sm text-slate-500">Manager: {manager?.name || 'Unknown'} · {head?.role === 'team_leader' ? `Leader: ${head.name}` : 'Reports to CJ Lara'}</p></div>
                <div className="grid grid-cols-3 gap-2 text-sm"><p><strong className="block text-2xl">{workers.length}</strong>Workers</p><p><strong className="block text-2xl">{salary.reduce((n: number, s: any) => n + s.closed, 0)}</strong>Closed Deals</p><p><strong className="block text-2xl">{salary.reduce((n: number, s: any) => n + s.done, 0)}</strong>Done Deals</p></div>
                <p className="text-sm">Tomorrow: {tomorrow.length} active · team target {tomorrow.reduce((n: number, w: any) => n + w.target, 0)} Closed and Done Deals each</p>
                <div className="text-sm">{Object.entries(totals).map(([currency, amount]) => <p key={currency}>{money(amount, currency)} team commission {salary.some((s: any) => s.provisional) ? '(provisional)' : '(final daily rate)'}</p>)}{!Object.keys(totals).length && <p>No fully paid orders for this work date.</p>}</div>
                <details className="border-t pt-3"><summary className="cursor-pointer font-semibold">Worker results and attendance</summary><div className="mt-3 space-y-3">{workers.map((worker: any) => {
                    const s = salary.find((v: any) => v.user_id === worker.id), plan = data.tomorrow.find((v: any) => v.user_id === worker.id);
                    return <div key={worker.id} className="border-t py-3 text-sm"><p className="font-semibold">{worker.name} {worker.telegram_username ? `(@${worker.telegram_username})` : ''}</p><p>{s ? `Closed ${s.closed}/${s.target} · Done ${s.done}/${s.target} · ${s.rate}%` : 'Results unavailable'}</p><label className="flex justify-between gap-3 mt-2">Tomorrow (target {plan?.target || 1})<select className="border rounded p-2" aria-label={`Attendance for ${worker.name}`} disabled={busy} value={plan?.active == null ? '' : String(plan.active)} onChange={e => onAttendance(worker.id, e.target.value === 'true')}><option value="" disabled>Unknown</option><option value="true">Active</option><option value="false">Inactive</option></select></label></div>;
                })}</div></details>
            </article>;
        })}</div>
    </section>;
}
