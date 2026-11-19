'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { requestDeadline } from '@/lib/request-deadline';

const field = 'block w-full rounded border border-slate-300 bg-white p-2 text-sm';
async function json(url: string, options?: RequestInit) {
    const response = await fetch(url, { cache: 'no-store', ...options }), body = await response.json();
    if (!response.ok) throw Object.assign(Error(body.error || 'Assignment unavailable'), { status: response.status });
    return body;
}
export default function VeoClientAssignment({ initialContactId = '', onSaved, onClose }: { initialContactId?: string; onSaved?: (result: any) => void; onClose?: () => void }) {
    const [contact, setContact] = useState(initialContactId), [search, setSearch] = useState(''), [items, setItems] = useState<any[]>([]);
    const [data, setData] = useState<any>(null), [seller, setSeller] = useState(''), [reason, setReason] = useState('');
    const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [mustReload, setMustReload] = useState(false), [message, setMessage] = useState(''), [version, setVersion] = useState(0);
    const writing = useRef(false);
    useEffect(() => {
        const controller = new AbortController();setItems([]);
        if (contact || !search.trim()) return () => controller.abort();
        const timer = setTimeout(() => {
            void requestDeadline(signal => json('/api/workspace/contacts?' + new URLSearchParams({ search: search.trim(), offset: '0' }), { signal }), 20000, controller.signal)
                .then(body => { if (!controller.signal.aborted) { setItems(body.items || []);setMessage(''); } })
                .catch(error => { if (!controller.signal.aborted) setMessage(error.message); });
        }, 250);
        return () => { clearTimeout(timer);controller.abort(); };
    }, [search, contact]);
    useEffect(() => {
        const controller = new AbortController();setData(null);setSeller('');setReason('');setMessage('');setMustReload(false);
        if (!contact) { setLoading(false);return () => controller.abort(); }
        setLoading(true);
        void requestDeadline(signal => json('/api/workspace/client-assignment?' + new URLSearchParams({ contact_id: contact }), { signal }), 20000, controller.signal)
            .then(body => {
                if (body.contact?.id !== contact || !Array.isArray(body.targets)) throw Error('Current assignment could not be loaded. Refresh to retry.');
                if (!controller.signal.aborted) setData(body);
            })
            .catch(error => { if (!controller.signal.aborted) { setMessage(error.message);setMustReload(true); } })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [contact, version]);
    const current = data?.contact?.id === contact ? data : null;
    async function save(event: FormEvent) {
        event.preventDefault();
        if (writing.current || loading || mustReload || !current || !seller || reason.trim().length < 3) return;
        writing.current = true;setBusy(true);setMessage('');
        try {
            const saved = await json('/api/workspace/client-assignment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contact_id: contact, seller_id: seller, expected_owner_id: current.owner?.id || null, reason: reason.trim() }) });
            setData(saved);setSeller('');setReason('');setMessage('Client assigned to ' + saved.owner.name + '. Past receipts, payments and sales credit are preserved.');onSaved?.(saved);
        } catch (error: any) { setMessage(error.message);setMustReload(true); }
        finally { writing.current = false;setBusy(false); }
    }
    return <section aria-label="Manual client assignment" className="space-y-3 rounded-xl border border-indigo-200 bg-indigo-50 p-4">
        <div className="flex justify-between gap-3"><h3 className="font-semibold">Manual client assignment</h3>{onClose && <button type="button" disabled={busy} className="text-sm underline" onClick={onClose}>Close assignment</button>}</div>
        <p className="text-sm">Managers can correct assignments within their branch and Pages. Team Leaders cover their Manager branches; Owners can transfer across branches. The change takes effect immediately. Past receipts, payments and sales credit keep their recorded seller.</p>
        {!contact && <div className="space-y-2"><label className="text-sm">Find client to assign<input className={field} maxLength={200} value={search} onChange={event => setSearch(event.target.value)} placeholder="Search client name or contact ID" /></label>
            {items.map(item => <button key={item.id} type="button" className="block text-left text-sm underline" onClick={() => setContact(item.id)}>{item.name || 'Unnamed client'} · {item.page_name || 'Assigned Page'}</button>)}</div>}
        {loading && <p className="text-sm">Loading current assignment…</p>}
        {message && <p role="status" className="rounded border bg-white p-3 text-sm">{message}</p>}
        {current && <form onSubmit={save} className="space-y-3"><fieldset disabled={busy || loading || mustReload} className="space-y-3">
            <p className="text-sm"><strong>{current.contact.name}</strong> · {current.contact.page_name}<br />Assigned to: <strong>{current.owner?.name || 'Unassigned'}</strong></p>
            <label className="block text-sm">Assign to<select required className={field} value={seller} onChange={event => setSeller(event.target.value)}><option value="">Choose a selling worker</option>{current.targets.filter((target: any) => target.id !== current.owner?.id).map((target: any) => <option key={target.id} value={target.id}>{target.name} · {target.role}</option>)}</select></label>
            <label className="block text-sm">Assignment reason<textarea required className={field} minLength={3} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
            <p className="text-xs">No Ready offer or worker acceptance is required. Assigning makes the worker Busy and pauses the chatbot for this client.</p>
            <button type="submit" disabled={busy || loading || mustReload || !seller || reason.trim().length < 3} className="rounded bg-indigo-700 px-3 py-2 text-sm text-white disabled:opacity-40">{busy ? 'Saving assignment…' : 'Assign client now'}</button>
        </fieldset></form>}
        {contact && <div className="flex gap-4 text-sm"><button type="button" disabled={busy || loading} className="underline" onClick={() => setVersion(value => value + 1)}>Reload current assignment</button>{!initialContactId && <button type="button" disabled={busy} className="underline" onClick={() => setContact('')}>Choose another client</button>}</div>}
    </section>;
}
