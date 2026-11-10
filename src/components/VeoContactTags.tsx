'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadTagOptions } from '@/lib/load-tag-options';
export default function VeoContactTags({ pageId, contactId, tags, onChanged }: { pageId: string; contactId: string; tags: any[]; onChanged: () => Promise<any> }) {
    const [available, setAvailable] = useState<any[]>([]), [selected, setSelected] = useState(''), [name, setName] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
    const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState('');
    const generation = useRef(0);
    const load = useCallback(async (signal?: AbortSignal) => {
        const issue = ++generation.current; setLoading(true); setLoadError('');
        try { const items = await loadTagOptions(pageId, signal, 'manual'); if (issue === generation.current && !signal?.aborted) setAvailable(items); }
        catch (error: any) { if (issue === generation.current && !signal?.aborted) { setAvailable([]); setLoadError(error.message); } throw error; }
        finally { if (issue === generation.current && !signal?.aborted) setLoading(false); }
    }, [pageId]);
    useEffect(() => {
        const controller = new AbortController(); setAvailable([]); setSelected(''); setName(''); setMessage('');
        void load(controller.signal).catch(() => {});
        return () => { controller.abort(); generation.current++; };
    }, [load]);
    async function change(action: 'add' | 'remove', id: string) {
        const r = await fetch(`/api/pages/${pageId}/contacts/bulk-${action}-tags`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contactIds: [contactId], tagIds: [id] }) }), b = await r.json();
        if (!r.ok) throw Error(b.message || b.error || 'Tag update failed');
        await onChanged(); setSelected(''); setMessage(action === 'add' ? 'Tag added.' : 'Tag removed.');
    }
    async function run(work: () => Promise<void>) { setBusy(true); setMessage(''); try { await work(); } catch (e: any) { setMessage(e.message); } finally { setBusy(false); } }
    return <section className="rounded-xl border bg-white p-5 space-y-3"><h2 className="font-semibold">Contact tags</h2>{message && <p role="status" className="text-sm">{message}</p>}{loadError && <p role="alert" className="text-sm text-red-700">{loadError} <button type="button" className="underline" onClick={() => void load().catch(() => {})}>Retry tags</button></p>}<div className="flex flex-wrap gap-2">{tags.map(t => <span key={t.id} className="inline-flex gap-2 items-center rounded border px-2 py-1 text-sm" style={{ borderColor: t.color }}>{t.name}{!t.system_key && !t.is_default && available.some(a => a.id === t.id) && <button aria-label={`Remove ${t.name} tag`} disabled={busy || loading} onClick={() => void run(() => change('remove', t.id))}>×</button>}</span>)}{!tags.length && <p className="text-sm text-slate-500">No tags assigned.</p>}</div>
        <div className="flex gap-2"><select aria-label="Contact tag" disabled={loading || !!loadError} className="min-w-0 flex-1 rounded border p-2 text-sm" value={selected} onChange={e => setSelected(e.target.value)}><option value="">{loading ? 'Loading manual tags…' : 'Choose a manual tag'}</option>{available.filter(t => !tags.some(a => a.id === t.id)).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select><button className="rounded border px-3" disabled={busy || loading || !!loadError || !selected} onClick={() => void run(() => change('add', selected))}>Add tag</button></div>
        <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void run(async () => { const r = await fetch('/api/tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, color: '#2563eb', ownerType: 'page', ownerId: pageId, pageId }) }), b = await r.json(); if (!r.ok || !b.tag?.id) throw Error(b.message || b.error || 'Could not create tag'); await load(); await change('add', b.tag.id); setName(''); }); }}><input aria-label="New contact tag" className="min-w-0 flex-1 rounded border p-2 text-sm" placeholder="New Page tag" required maxLength={100} value={name} onChange={e => setName(e.target.value)} /><button className="rounded border px-3" disabled={busy || !name.trim()}>Create and add</button></form><p className="text-xs text-slate-500">Manual tags are shared within their permitted Page. System and stage-history tags are maintained separately. Tags do not verify payments.</p></section>;
}
