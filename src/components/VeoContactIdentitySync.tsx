'use client';
import { useState } from 'react';
export default function VeoContactIdentitySync({ pages }: { pages: Array<{ id: string; name: string }> }) {
    const [page, setPage] = useState(''), [cursor, setCursor] = useState<string | null>(null), [busy, setBusy] = useState(false);
    const [message, setMessage] = useState(''), [total, setTotal] = useState(0), [done, setDone] = useState(false);
    async function sync() {
        if (!page || busy || done) return;
        setBusy(true); setMessage('Reading a contact batch…');
        try {
            const response = await fetch('/api/workspace/contacts/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page_id: page, cursor }) });
            const result = await response.json(); if (!response.ok) throw Error(result.error || 'Contact sync unavailable');
            const nextTotal = total + result.inserted;
            setTotal(nextTotal); setCursor(result.next_cursor); setDone(result.complete);
            setMessage(`${nextTotal} contacts added. ${result.skipped} already saved or repeated in this batch. ${result.complete ? 'Page sync complete.' : 'Choose Continue to read the next batch.'}`);
        } catch (error) { setMessage(error instanceof Error ? error.message : 'Contact sync failed; retry this batch'); }
        finally { setBusy(false); }
    }
    return <section className="rounded border bg-white p-5 space-y-3"><h2 className="font-bold text-xl">Sync contacts</h2>
        <p className="text-sm text-slate-600">Add contact names and identities in small batches. Existing contacts stay unchanged. Messages, past sales, and old automation activity are not imported.</p>
        <label className="block">Page<select className="block w-full rounded border p-2" disabled={busy} value={page} onChange={event => { setPage(event.target.value); setCursor(null); setTotal(0); setDone(false); setMessage(''); }}><option value="">Choose a Page</option>{pages.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <button className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-40" disabled={!page || busy || done} onClick={sync}>{busy ? 'Syncing…' : cursor ? 'Continue sync' : done ? 'Complete' : 'Sync first batch'}</button>
        {message && <p role="status" className="text-sm">{message}</p>}
    </section>;
}
