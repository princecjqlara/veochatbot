'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

export default function VeoClientDrawer({ contactId, onClose }: { contactId: string; onClose: () => void }) {
    const [data, setData] = useState<any>(null), [error, setError] = useState(''), [refreshing, setRefreshing] = useState(false);
    useEffect(() => {
        if (!contactId) return;
        const controller = new AbortController();
        fetch('/api/workspace/source?contact_id=' + encodeURIComponent(contactId), { cache: 'no-store', signal: controller.signal })
            .then(async r => { const b = await r.json(); if (!r.ok) throw Error(b.error); if (!controller.signal.aborted) setData(b); })
            .catch(e => { if (e.name !== 'AbortError') setError(e.message); });
        return () => controller.abort();
    }, [contactId]);
    async function refreshSource() {
        setRefreshing(true);setError('');
        try { const r = await fetch('/api/workspace/source', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'refresh', contact_id: contactId }) }), b = await r.json();if (!r.ok) throw Error(b.error);setData((old: any) => old ? { ...old, sync: { ...old.sync, status: b.status || 'pending' } } : old); }
        catch (e: any) { setError(e.message); } finally { setRefreshing(false); }
    }
    useEffect(() => { const browser = globalThis.window;if (!browser) return;const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };browser.addEventListener('keydown', key);return () => browser.removeEventListener('keydown', key); }, [onClose]);
    if (!contactId) return null;
    const contact = data?.contact;
    return <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/40" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
        <aside role="dialog" aria-modal="true" aria-label="Client details" className="h-full w-full max-w-xl overflow-y-auto bg-white p-5 shadow-xl sm:p-7" onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
            <header className="flex items-start justify-between gap-4 border-b pb-4"><div><p className="text-xs uppercase tracking-wide text-slate-500">Client workspace</p><h2 className="mt-1 text-2xl font-bold">{contact?.name || (error ? 'Client unavailable' : 'Loading client…')}</h2>{contact && <p className="text-sm text-slate-600">{contact.page_name} · {contact.pipeline_stage?.replaceAll('_', ' ')}</p>}</div><button autoFocus onClick={onClose} className="rounded border px-3 py-2" aria-label="Close client details">Close</button></header>
            <nav aria-label="Client actions" className="flex flex-wrap gap-2 border-b py-4"><Link onClick={onClose} className="rounded bg-slate-900 px-3 py-2 text-sm text-white" href={`/dashboard/workspace?view=new_clients&contact_id=${contactId}`}>Assignment & handover</Link><Link onClick={onClose} className="rounded border px-3 py-2 text-sm" href={`/dashboard/workspace?view=receipts&contact_id=${contactId}`}>Receipts & orders</Link>{contact?.page_id && <Link onClick={onClose} className="rounded border px-3 py-2 text-sm" href={`/dashboard/contacts/${contactId}?pageId=${contact.page_id}`}>Full contact profile</Link>}</nav>
            {error && <p role="alert" className="mt-4 rounded border border-amber-300 bg-amber-50 p-3">{error}</p>}
            {data && <div className="space-y-5 py-5"><section><h3 className="font-semibold">Client details · {data.intake?.detail_count || 0}/3 for a fresh assignment</h3><dl className="mt-2 grid gap-2 sm:grid-cols-2">{Object.entries(data.fields || {}).map(([key, value]) => <div key={key} className="rounded border p-3"><dt className="text-xs text-slate-500">{key}</dt><dd className="break-words text-sm">{String(value)}</dd></div>)}</dl></section>
                <section className="rounded border p-4"><h3 className="font-semibold">Facebook source</h3><p className="mt-1 text-sm">{data.evidence?.stage || 'No current explicit stage'} · {data.evidence?.source || 'unavailable'}</p><p className="mt-1 text-xs text-slate-600">{data.evidence?.coverage}</p><p className="mt-1 text-xs">Refresh: {data.sync?.status || 'not queued'}{data.sync?.last_error ? ` · ${data.sync.last_error}` : ''}</p><button className="mt-2 text-sm underline disabled:opacity-40" disabled={refreshing} onClick={() => void refreshSource()}>{refreshing ? 'Queueing refresh…' : 'Refresh Facebook in background'}</button><p className="mt-2 text-sm">Order reconciliation: {data.draft?.status || 'No order draft'}{data.draft?.note ? ` · ${data.draft.note}` : ''}</p></section>
                <section><h3 className="font-semibold">Recent stage history</h3>{data.stage_history?.length ? <ul className="mt-2 space-y-1 text-sm">{data.stage_history.map((event: any, i: number) => <li key={`${event.stage}-${event.occurred_at}-${i}`}>{event.label || event.stage} · {new Date(event.occurred_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} PHT</li>)}</ul> : <p className="mt-1 text-sm text-slate-500">No saved Facebook stage events.</p>}</section>
            </div>}
        </aside>
    </div>;
}
