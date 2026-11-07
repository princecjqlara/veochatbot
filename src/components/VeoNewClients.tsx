'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
const field = 'block w-full rounded border border-slate-300 bg-white p-2 text-sm';
const button = 'rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-40';
const stamp = (v: string | null) => v ? new Date(v).toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' }) + ' PHT' : 'Not set';
export default function VeoNewClients({ scope, pages, initialContactId = '' }: { scope: any; pages: any[]; initialContactId?: string }) {
    const [data, setData] = useState<any>(null), [view, setView] = useState('pool'), [search, setSearch] = useState(initialContactId), [page, setPage] = useState(''), [offset, setOffset] = useState(0);
    const [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [version, setVersion] = useState(0);
    const [targets, setTargets] = useState<Record<string, string>>({}), requests = useRef(new Map<string, string>());
    useEffect(() => { const timer = setInterval(() => setVersion(v => v + 1), 30000); return () => clearInterval(timer); }, []);
    useEffect(() => {
        const c = new AbortController();setLoading(true);
        const timer = setTimeout(async () => {
            try {
                const r = await fetch('/api/workspace/new-clients?' + new URLSearchParams({ view, search, offset: String(offset), ...(page ? { page_id: page } : {}) }), { cache: 'no-store', signal: c.signal });
                const b = await r.json();if (!r.ok) throw Error(b.error);if (!Array.isArray(b.items) || !Array.isArray(b.roster) || typeof b.readiness?.ready !== 'boolean') throw Error('Client assignments are unavailable. Refresh to retry.');if (!c.signal.aborted) setData(b);
            } catch (e: any) { if (!c.signal.aborted) { setData(null);setMessage(e.message); } } finally { if (!c.signal.aborted) setLoading(false); }
        }, 250);
        return () => { clearTimeout(timer);c.abort(); };
    }, [view, search, page, offset, version]);
    async function save(body: any) {
        const key = JSON.stringify(body);if (!requests.current.has(key)) requests.current.set(key, crypto.randomUUID());
        setBusy(true);setMessage('');
        try {
            const r = await fetch('/api/workspace/new-clients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, request_id: requests.current.get(key) }) });
            const b = await r.json();if (!r.ok) throw Error(b.error);requests.current.delete(key);
            setMessage(body.action === 'accept' ? 'Client accepted. Your status is now Busy. Open the client to continue; choose Ready again when you can take another client.' : body.action === 'offer' ? 'Client offered. The assignment changes only when the worker accepts.' : body.action === 'readiness' ? body.status === 'ready' ? 'Ready for up to 30 minutes. Renew when needed.' : 'Busy. Pending offers to you have been cancelled.' : 'Offer updated.');
            setVersion(v => v + 1);return true;
        } catch (e: any) { setMessage(e.message);setVersion(v => v + 1);return false; } finally { setBusy(false); }
    }
    const canSell = ['member', 'manager'].includes(scope.role), ready = data?.readiness?.ready === true && !loading;
    return <section aria-label="New client assignments" className="space-y-4 rounded-xl border bg-white p-5">
        <div className="flex flex-wrap justify-between gap-3"><h2 className="text-xl font-bold">New clients</h2><button className="text-sm underline" disabled={busy} onClick={() => setVersion(v => v + 1)}>Refresh assignments</button></div>
        <p className="text-sm">Choose Ready to take a client. Offers last up to 15 minutes. Accepting makes you Busy and pauses the chatbot for that client so you can handle the conversation. Ready/Busy is separate from Jaucian’s active-for-tomorrow poll.</p>
        {message && <p role="status" className="rounded border bg-amber-50 p-3 text-sm">{message}</p>}
        {canSell && <div className="rounded border bg-slate-50 p-4 space-y-2"><p className="font-semibold">Your status: {loading ? 'Checking…' : data ? ready ? 'Ready' : 'Busy / Ready expired' : 'Unavailable'}</p>{ready && <p className="text-sm">Ready until {stamp(data.readiness.expires_at)}. Status also ends at Philippine midnight.</p>}<div className="flex gap-3"><button className={button} disabled={busy || loading || !data} onClick={() => void save({ action: 'readiness', status: 'ready' })}>{ready ? 'Renew Ready' : 'Ready'}</button><button className="rounded border px-3 py-2 text-sm disabled:opacity-40" disabled={busy || loading || !data} onClick={() => void save({ action: 'readiness', status: 'busy' })}>Busy</button></div></div>}
        <div className="flex flex-wrap gap-2">{[['pool', 'Available clients'], ['offers', scope.role === 'member' ? 'My offers' : 'Team offers'], ['assigned', scope.role === 'member' ? 'My accepted clients' : 'Assigned clients']].map(([v, label]) => <button key={v} className={`rounded border px-3 py-2 text-sm ${view === v ? 'bg-slate-900 text-white' : ''}`} onClick={() => { setView(v);setOffset(0); }}>{label}</button>)}</div>
        <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Search client<input className={field} value={search} maxLength={200} placeholder="Client name, ID or Page" onChange={e => { setSearch(e.target.value);setOffset(0); }} /></label><label className="text-sm">Page<select className={field} value={page} onChange={e => { setPage(e.target.value);setOffset(0); }}><option value="">All permitted Pages</option>{pages.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label></div>
        {data && <details className="rounded border p-3"><summary className="cursor-pointer text-sm font-semibold">Ready / Busy team status</summary><div className="mt-2 space-y-1 text-sm">{data.roster.map((w: any) => <p key={w.id}>{w.name} · {w.role} · {w.ready ? `Ready until ${stamp(w.ready_until)}` : 'Busy / Ready expired'}</p>)}</div></details>}
        {loading && <p className="text-sm">Checking current assignments…</p>}
        {!loading && data && !data.items.length && <p className="text-sm text-slate-500">No clients match this view. Available clients use new activity since launch and exclude existing sales and reserved clients.</p>}
        {(data?.items || []).map((c: any) => {
            const eligible = data.roster.filter((w: any) => w.ready && w.id !== c.owner_id && w.page_ids.includes(c.page_id));
            return <article key={c.id} className="space-y-2 rounded border p-4"><div className="flex flex-wrap justify-between gap-2"><Link href={`/dashboard/contacts/${c.id}?pageId=${c.page_id}`} className="font-semibold underline">{c.name || 'Unknown client'}</Link><span className="text-xs">{c.page_name} · Lead: {c.pipeline_stage?.replaceAll('_', ' ') || 'Unknown'}</span></div>
                <p className="text-sm">Assigned to: {c.owner_name || 'Unassigned'}</p>
                {c.offer_id && <p className="text-sm">Offered to {c.offered_to_name || 'Worker'} · expires {stamp(c.offer_expires_at)}{!c.offer_authorized && ' · Access or assignment changed; ask for a new offer'}</p>}
                <div className="flex flex-wrap gap-3 text-sm">
                    {canSell && view === 'pool' && <button disabled={busy || loading || !ready} className={button} onClick={() => void save({ action: 'accept', contact_id: c.id })}>Accept client</button>}
                    {c.offer_id && c.offered_to === scope.user_id && <><button disabled={busy || loading || !ready || !c.offer_authorized} className={button} onClick={() => void save({ action: 'accept', contact_id: c.id, offer_id: c.offer_id })}>Accept offered client</button><button disabled={busy || loading} className="underline" onClick={() => void save({ action: 'decline', contact_id: c.id, offer_id: c.offer_id })}>Decline</button></>}
                    {c.offer_id && (c.offered_by === scope.user_id || scope.role !== 'member') && <button disabled={busy || loading} className="underline" onClick={() => void save({ action: 'cancel', contact_id: c.id, offer_id: c.offer_id })}>Cancel offer</button>}
                </div>
                {c.can_offer && <form className="grid gap-2 border-t pt-3 sm:grid-cols-2" onSubmit={async e => {
                    e.preventDefault();const form = e.currentTarget, reason = String(new FormData(form).get('reason') || '');
                    if (await save({ action: 'offer', contact_id: c.id, user_id: targets[c.id], reason })) form.reset();
                }}><label className="text-sm">{c.owner_id ? 'Reassign to a Ready worker' : 'Offer to a Ready worker'}<select required className={field} value={targets[c.id] || ''} onChange={e => setTargets(t => ({ ...t, [c.id]: e.target.value }))}><option value="">Choose a Ready worker</option>{eligible.map((w: any) => <option key={w.id} value={w.id}>{w.name} · {w.role}</option>)}</select></label><label className="text-sm">{c.owner_id ? 'Reassignment reason' : 'Note (optional)'}<input name="reason" className={field} required={!!c.owner_id} minLength={c.owner_id ? 3 : undefined} maxLength={500} /></label><button disabled={busy || loading || !eligible.some((w: any) => w.id === targets[c.id])} className={button}>{c.owner_id ? 'Offer reassignment' : 'Offer client'}</button><p className="text-xs self-center">Existing sales and commission retain their recorded seller. The current worker keeps the client until acceptance.</p></form>}
            </article>;
        })}
        {data?.total > 0 && <div className="flex justify-between text-sm"><button disabled={!offset || loading} className="underline disabled:opacity-40" onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button><span>{data.total} clients</span><button disabled={offset + 50 >= data.total || loading} className="underline disabled:opacity-40" onClick={() => setOffset(offset + 50)}>Next</button></div>}
    </section>;
}
