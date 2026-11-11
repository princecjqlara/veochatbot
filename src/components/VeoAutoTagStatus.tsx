'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
const errors: Record<string, string> = {
    PAGE_CONNECTION_REQUIRED: 'Reconnect this Page.', PAGE_RECONNECT_REQUIRED: 'Refresh Facebook permissions.',
    CONTACT_SYNC_REQUIRED: 'Sync this Page’s contacts; known contacts are still processed.',
    META_READ_UNAVAILABLE: 'Meta read failed; retry is scheduled.', META_RESPONSE_INCOMPLETE: 'Meta returned incomplete data; retry is scheduled.',
    META_STAGE_EVIDENCE_INCOMPLETE: 'Meta returned incomplete stage evidence; retry is scheduled.'
};
export default function VeoAutoTagStatus() {
    const [data, setData] = useState<any>(null), [error, setError] = useState(''), [version, setVersion] = useState(0);
    useEffect(() => {
        const controller = new AbortController();
        void fetch('/api/workspace/autotag', { cache: 'no-store', signal: controller.signal }).then(async response => {
            const body = await response.json(); if (!response.ok || !Array.isArray(body.pages)) throw Error(body.error || 'Auto-tag status is unavailable');
            if (!controller.signal.aborted) { setData(body); setError(''); }
        }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
        return () => controller.abort();
    }, [version]);
    return <section className="rounded-xl border bg-white p-4 space-y-3" aria-label="Auto-tag recovery by Page">
        <div className="flex flex-wrap justify-between gap-2"><h2 className="font-bold text-lg">Auto-tag recovery</h2><button className="underline text-sm" onClick={() => setVersion(v => v + 1)}>Recheck tag status</button></div>
        <p className="text-sm text-slate-600">Webhooks save stage history immediately. Scheduled scans recover exposed notices on existing contacts and restore missing saved history tags. Meta may omit administrative notices; a successful scan cannot prove every Business Suite change was exposed.</p>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {!data && !error && <p role="status" className="text-sm">Loading Page tag status…</p>}
        {data && <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead><tr>{['Page', 'Recovery status', 'Last successful scan', 'Observed stage notices'].map(label => <th className="p-2 border-b" key={label}>{label}</th>)}</tr></thead><tbody>{data.pages.map((page: any) => <tr key={page.page_id}>
            <td className="p-2 border-b"><Link className="underline" href={'/dashboard/contacts?pageId=' + page.page_id}>{page.name}</Link></td>
            <td className="p-2 border-b">{!page.enabled ? 'Disabled in settings' : page.last_error ? errors[page.last_error] || 'Recovery needs attention; retry is scheduled.' : !page.last_success_at ? 'Waiting for first scan' : Date.now() - Date.parse(page.last_success_at) > 900000 ? 'Scan is overdue; check collection health.' : page.pending_history ? 'Scanning additional conversations' : 'Recent scan successful'}</td>
            <td className="p-2 border-b">{page.last_success_at ? new Date(page.last_success_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) + ' PHT' : 'Not checked yet'}</td>
            <td className="p-2 border-b">{page.stage_events || 0}<span className="block text-xs text-slate-500">Repeat observations are deduplicated when saved.</span></td>
        </tr>)}</tbody></table></div>}
    </section>;
}
