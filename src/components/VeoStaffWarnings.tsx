'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { receiptHoldLabels } from '@/lib/veo-receipts';
import VeoDisciplineControls from './VeoDisciplineControls';

const field = 'w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm';
const kinds: Record<string, string> = { overdue_without_reason: 'Overdue projects', salary_on_hold: 'Salary holds', availability_unanswered: 'Unanswered Telegram polls', telegram_mapping_missing: 'Telegram linking' };
const severityNames: Record<string, string> = { warning: 'Warning', hold: 'On hold', attention: 'Attention' };
const severityOrder: Record<string, number> = { warning: 0, hold: 1, attention: 2 };
const timestamp = (value: string) => new Date(value).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function WarningLinks({ warning: w }: { warning: any }) {
    return <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {(w.receipt_id || w.review_id) && <Link className="underline" href="/dashboard/workspace?view=receipts">Receipt</Link>}
        {w.contact_id && <Link className="underline" href={`/dashboard/contacts/${w.contact_id}?pageId=${w.page_id}`}>Client</Link>}
        {w.poll_url?.startsWith('https://t.me/') && <a className="underline" href={w.poll_url} target="_blank" rel="noreferrer">Telegram poll</a>}
    </div>;
}
export default function VeoStaffWarnings({ workerId, compact = false, refreshToken }: { workerId?: string; compact?: boolean; refreshToken?: unknown }) {
    const [data, setData] = useState<any>(null), [error, setError] = useState(''), [version, setVersion] = useState(0), [loading, setLoading] = useState(true);
    const [person, setPerson] = useState(''), [severity, setSeverity] = useState(''), [kind, setKind] = useState(''), [search, setSearch] = useState(''), [includeClear, setIncludeClear] = useState(false), [page, setPage] = useState(0);
    const [includeHistory, setIncludeHistory] = useState(false);
    useEffect(() => { setData(null);setPerson('');setPage(0); }, [workerId]);
    useEffect(() => {
        const controller = new AbortController();setLoading(true);
        void fetch('/api/workspace/warnings' + (workerId ? '?worker_id=' + encodeURIComponent(workerId) : ''), { cache: 'no-store', signal: controller.signal }).then(async response => {
            const body = await response.json();
            if (!response.ok || !Array.isArray(body.workers) || body.workers.some((p: any) => !Array.isArray(p.warnings))) throw Object.assign(Error(body.error || 'Complete warnings are temporarily unavailable'), { status: response.status });
            if (!controller.signal.aborted) { setData(body);setError(''); }
        }).catch(e => { if (!controller.signal.aborted) { setError(e.message);if ([401, 403].includes(e.status)) setData(null); } })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [workerId, version, refreshToken]);

    const people: any[] = data?.workers || [], query = search.trim().toLowerCase();
    const matchesPerson = (p: any) => (!workerId || p.id === workerId) && (!person || p.id === person);
    const rows = people.filter(matchesPerson).flatMap(p => p.warnings.filter((w: any) => (includeHistory || w.counts_toward_suspension !== false) && (!severity || w.severity === severity) && (!kind || w.kind === kind) && (!query || `${p.name} ${w.title} ${(w.reasons || []).map((r: string) => receiptHoldLabels[r] || r).join(' ')}`.toLowerCase().includes(query))).map((warning: any) => ({ person: p, warning })))
        .sort((a, b) => (severityOrder[a.warning.severity] ?? 3) - (severityOrder[b.warning.severity] ?? 3) || Number(b.warning.overdue_hours || 0) - Number(a.warning.overdue_hours || 0) || a.person.name.localeCompare(b.person.name));
    const counts = rows.reduce((n: Record<string, number>, row) => { if (row.warning.counts_toward_suspension !== false) n[row.warning.severity] = (n[row.warning.severity] || 0) + 1;return n; }, {});
    const size = compact ? 6 : 20, currentPage = compact ? 0 : Math.min(page, Math.max(0, Math.ceil(rows.length / size) - 1)), visible = rows.slice(currentPage * size, (currentPage + 1) * size);
    const availableKinds: string[] = [...new Set<string>(people.flatMap(p => p.warnings.map((w: any) => w.kind)))].sort();
    const clearPeople = includeClear ? people.filter(p => matchesPerson(p) && !p.warnings.some((w: any) => w.counts_toward_suspension !== false) && (!query || p.name.toLowerCase().includes(query))) : [];
    const filters = <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {!workerId && <label className="text-xs text-slate-600">Employee<select aria-label="Warning employee" className={field} value={person} onChange={e => { setPerson(e.target.value);setPage(0); }}><option value="">All permitted staff</option>{people.map(p => <option key={p.id} value={p.id}>{p.name}{p.active === false ? ' (former staff)' : ''}</option>)}</select></label>}
        <label className="text-xs text-slate-600">Severity<select aria-label="Warning severity" className={field} value={severity} onChange={e => { setSeverity(e.target.value);setPage(0); }}><option value="">All severities</option>{Object.entries(severityNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="text-xs text-slate-600">Type<select aria-label="Warning type" className={field} value={kind} onChange={e => { setKind(e.target.value);setPage(0); }}><option value="">All issue types</option>{availableKinds.map(key => <option key={key} value={key}>{kinds[key] || key.replaceAll('_', ' ')}</option>)}</select></label>
        <label className="text-xs text-slate-600">Search<input aria-label="Search warnings" className={field} value={search} onChange={e => { setSearch(e.target.value);setPage(0); }} placeholder="Employee or issue" /></label>
        <label className="flex items-center gap-2 text-xs sm:col-span-2"><input type="checkbox" checked={includeClear} onChange={e => setIncludeClear(e.target.checked)} />Include staff with no warnings</label>
        <label className="flex items-center gap-2 text-xs sm:col-span-2"><input type="checkbox" checked={includeHistory} onChange={e => setIncludeHistory(e.target.checked)} />Include warnings already used for a suspension</label>
    </div>;
    return <section aria-label="Staff warnings and Telegram participation" className="space-y-3 rounded-xl border bg-white p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold">Staff warnings</h2><button type="button" className="text-xs underline disabled:opacity-50" disabled={loading} onClick={() => setVersion(v => v + 1)}>Recheck warnings</button></div>
        {data && <p className="text-xs text-slate-600">{counts.warning || 0} warnings · {counts.hold || 0} salary holds · {counts.attention || 0} items needing attention for these filters.</p>}
        {data?.discipline_note && !compact && <p className="text-xs text-slate-600">{data.discipline_note}</p>}
        {data?.can_manage_discipline && !compact && <VeoDisciplineControls workers={people} policy={data.discipline_policy || {}} onChanged={() => setVersion(v => v + 1)} />}
        {compact ? <details><summary className="cursor-pointer text-xs underline">Filter warnings</summary><div className="mt-2">{filters}</div></details> : filters}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {loading && <p role="status" className="text-xs text-slate-500">Checking staff obligations…</p>}
        {data && <>
            {!!visible.length && <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{['Employee', 'Issue', 'Level', 'Due / date', 'Open'].map(label => <th key={label} className="border-b px-2 py-1.5 text-xs font-medium text-slate-500">{label}</th>)}</tr></thead><tbody>{visible.map(({ person: p, warning: w }) => <tr key={p.id + ':' + w.key}>
                <td className="border-b px-2 py-2 align-top"><span className="font-medium">{p.name}</span><span className="block text-xs text-slate-500">{p.role.replaceAll('_', ' ')}{p.active === false ? ' · former staff' : ''}</span></td>
                <td className="border-b px-2 py-2 align-top">{w.title}{w.overdue_hours != null && <span className="block text-xs text-red-700">{Math.ceil(w.overdue_hours)} hours overdue; add an honest explanation in the order’s project status.</span>}{!!w.reasons?.length && <details className="mt-1 text-xs"><summary className="cursor-pointer underline">Reasons</summary><ul className="mt-1 list-disc pl-4">{w.reasons.map((reason: string) => <li key={reason}>{receiptHoldLabels[reason] || reason}</li>)}</ul></details>}</td>
                <td className="border-b px-2 py-2 align-top"><span className={`whitespace-nowrap rounded px-2 py-0.5 text-xs ${w.severity === 'warning' ? 'bg-red-50 text-red-800' : w.severity === 'hold' ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-700'}`}>{severityNames[w.severity] || w.severity}</span>{w.counts_toward_suspension === false && <span className="mt-1 block text-xs text-slate-500">Already included in a suspension</span>}</td>
                <td className="border-b px-2 py-2 align-top text-xs text-slate-600">{w.due_at ? timestamp(w.due_at) + ' PHT' : w.work_date || (w.created_at ? timestamp(w.created_at) + ' PHT' : '—')}</td>
                <td className="border-b px-2 py-2 align-top"><WarningLinks warning={{ ...w, poll_url: w.poll_url || p.poll?.poll_url }} /></td>
            </tr>)}</tbody></table></div>}
            {!rows.length && <p className="text-sm text-slate-600">No warnings match these filters.</p>}
            {!!clearPeople.length && <details className="text-xs"><summary className="cursor-pointer">{clearPeople.length} staff with no current warning or salary hold</summary><ul className="mt-2 space-y-1">{clearPeople.map(p => <li key={p.id}>{p.name} · Tomorrow: {p.active_tomorrow == null ? 'Poll / vote not available yet' : p.active_tomorrow ? 'Active — Telegram vote' : 'Inactive — Telegram vote'}{p.poll?.poll_url?.startsWith('https://t.me/') && <> · <a className="underline" href={p.poll.poll_url} target="_blank" rel="noreferrer">Open poll</a></>}</li>)}</ul></details>}
            {rows.length > size && !compact && <div className="flex items-center justify-between text-xs"><button className="underline disabled:opacity-40" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous warnings</button><span>{currentPage * size + 1}–{Math.min(rows.length, (currentPage + 1) * size)} of {rows.length}</span><button className="underline disabled:opacity-40" disabled={(currentPage + 1) * size >= rows.length} onClick={() => setPage(currentPage + 1)}>Next warnings</button></div>}
            {compact && <Link className="text-xs underline" href="/dashboard/workspace?view=warnings">View all staff warnings and poll participation{rows.length > size ? ` (${rows.length} matching issues)` : ''}</Link>}
            <p className="text-xs text-slate-500">Checked {timestamp(data.as_of)} PHT. Active for tomorrow comes from Jaucian’s Telegram poll. Missing or stale data is unknown, and warnings never deduct salary automatically.</p>
        </>}
    </section>;
}
