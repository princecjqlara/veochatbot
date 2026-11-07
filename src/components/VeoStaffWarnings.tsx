'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { receiptHoldLabels } from '@/lib/veo-receipts';
export default function VeoStaffWarnings({ workerId, compact = false, refreshToken }: { workerId?: string; compact?: boolean; refreshToken?: unknown }) {
    const [data, setData] = useState<any>(null), [error, setError] = useState(''), [version, setVersion] = useState(0);
    useEffect(() => {
        const c = new AbortController();
        void fetch('/api/workspace/warnings' + (workerId ? '?worker_id=' + workerId : ''), { cache: 'no-store', signal: c.signal }).then(async r => { const b = await r.json(); if (!r.ok) throw Error(b.error); setData(b); setError(''); }).catch(e => { if (!c.signal.aborted) setError(e.message); });
        return () => c.abort();
    }, [workerId, version, refreshToken]);
    const people = data?.workers || [], counts = people.reduce((n: any, p: any) => { for (const w of p.warnings) n[w.severity] = (n[w.severity] || 0) + 1; return n; }, {});
    return <section aria-label="Staff warnings and Telegram participation" className="rounded-xl border bg-white p-5 space-y-3">
        <div className="flex flex-wrap justify-between gap-3"><h2 className="text-lg font-bold">Staff warnings and tomorrow’s Telegram vote</h2><button className="underline text-sm" onClick={() => setVersion(v => v + 1)}>Recheck warnings</button></div>
        <p className="text-sm">{counts.warning || 0} warnings · {counts.hold || 0} salary holds · {counts.attention || 0} items needing attention. Staff see their own records; supervisors see their permitted branch.</p>
        <p className="text-xs text-slate-500">Active for tomorrow comes from Jaucian’s Telegram poll. The workspace reads the vote; it does not collect a second declaration. Waiting for a client’s balance after the project is finished is not staff overdue. Warnings do not deduct salary automatically.</p>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {!data && !error && <p className="text-sm">Checking staff obligations…</p>}
        {(compact ? people.filter((p: any) => p.warnings.length).slice(0, 8) : people).map((p: any) => <article className="rounded border p-3 text-sm space-y-2" key={p.id}>
            <h3 className="font-semibold">{p.name} · {p.role.replaceAll('_', ' ')}{!p.active && ' · former staff'}</h3>
            <p>Tomorrow ({data.tomorrow}): {p.active_tomorrow == null ? p.poll?.poll_id ? 'No current vote recorded' : 'Poll / vote not available yet' : p.active_tomorrow ? 'Active — Telegram vote' : 'Inactive — Telegram vote'}</p>
            {p.poll?.poll_url?.startsWith('https://t.me/') && <a className="underline" href={p.poll.poll_url} target="_blank" rel="noreferrer">Open Jaucian’s active-for-tomorrow poll</a>}
            {!p.warnings.length && <p className="text-slate-500">No current warning or salary hold.</p>}
            {p.warnings.map((w: any) => <div className={`rounded p-3 ${w.severity === 'warning' ? 'bg-red-50' : w.severity === 'hold' ? 'bg-amber-50' : 'bg-slate-50'}`} key={w.key}>
                <p className="font-semibold">{w.severity === 'warning' ? 'Warning' : w.severity === 'hold' ? 'On hold' : 'Attention'}: {w.title}</p>
                {w.overdue_hours != null && <p>{Math.ceil(w.overdue_hours)} hours overdue; add an honest explanation in the order’s project status.</p>}
                {!!w.reasons?.length && <ul className="list-disc pl-5">{w.reasons.map((key: string) => <li key={key}>{receiptHoldLabels[key] || key}</li>)}</ul>}
                <div className="flex flex-wrap gap-4 mt-2">{w.receipt_id && <Link className="underline" href="/dashboard/workspace?view=receipts">Open receipt checklist and Recheck</Link>}{w.contact_id && <Link className="underline" href={`/dashboard/contacts/${w.contact_id}?pageId=${w.page_id}`}>Open client</Link>}{w.poll_url?.startsWith('https://t.me/') && <a className="underline" href={w.poll_url} target="_blank" rel="noreferrer">Answer Telegram poll</a>}</div>
            </div>)}
        </article>)}
        {compact && <Link className="underline text-sm" href="/dashboard/workspace?view=warnings">View all staff warnings and poll participation</Link>}
        {data && <p className="text-xs text-slate-500">Checked {new Date(data.as_of).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} PHT. Missing or stale Telegram data is shown as unknown; a missed-vote warning requires a posted poll and a response window.</p>}
    </section>;
}
