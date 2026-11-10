'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { startAdaptivePolling } from '@/lib/adaptive-polling';
const money = (n: number, currency: string) => new Intl.NumberFormat('en-PH', { style: 'currency', currency }).format(n / 100);
export default function VeoBusinessOrderPicker({ contactId, seller, closedDealId, dealMode, onSaved }: {
    contactId: string; seller: string; closedDealId: string; dealMode: 'new' | 'existing'; onSaved: (id: string) => void;
}) {
    const [data, setData] = useState<any>(null), [selected, setSelected] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
    const [waiting, setWaiting] = useState(false);
    const generation = useRef(0), mounted = useRef(true);
    const currentContact = useRef(contactId); currentContact.current = contactId;
    const active = useRef('');active.current = `${contactId}:${seller}:${closedDealId}:${dealMode}`;
    const receive = useCallback((body: any) => {
        if (!Array.isArray(body.items)) throw Error('The complete Facebook order list is unavailable. Retry Fetch Facebook orders.');
        setData(body); setSelected(current => body.items.some((item: any) => item.id === current) ? current : '');
        const job = body.source?.sync;
        const pending = ['pending', 'processing', 'failed'].includes(job?.status) || body.queued === true && job?.status !== 'idle';
        setWaiting(pending);
        setMessage(pending ? job?.last_error ? `${job.last_error}. Facebook refresh will retry automatically.` : 'Facebook refresh queued or running. Saved orders are shown below; this list updates automatically when the check finishes.'
            : body.items.length ? body.source?.evidence?.coverage || body.scan?.coverage || 'Saved Facebook orders loaded. Choose the matching invoice.'
                : 'No accessible order notice with an invoice ID and total was returned. Create the order in Business Suite, then fetch again. Meta may not expose every order.');
    }, []);
    useEffect(() => {
        mounted.current = true; const issue = ++generation.current;
        setData(null);setSelected('');setMessage('');setWaiting(false);const c = new AbortController();
        void fetch('/api/workspace/business-orders?' + new URLSearchParams({ contact_id: contactId }), { cache: 'no-store', signal: c.signal }).then(async r => {
            const b = await r.json();if (!r.ok) throw Error(b.error);if (!c.signal.aborted && issue === generation.current) receive(b);
        }).catch(e => { if (!c.signal.aborted && issue === generation.current) setMessage(e.message); });
        return () => { c.abort(); mounted.current = false; generation.current++; };
    }, [contactId, receive]);
    useEffect(() => {
        if (!waiting || busy) return;
        return startAdaptivePolling(async signal => {
            const issue = ++generation.current;
            try {
                const r = await fetch('/api/workspace/business-orders?' + new URLSearchParams({ contact_id: contactId }), { cache: 'no-store', signal });
                const body = await r.json(); if (!r.ok) throw Error(body.error || 'Could not check Facebook refresh progress.');
                if (!signal.aborted && issue === generation.current) receive(body);
            } catch (e: any) { if (!signal.aborted && issue === generation.current) setMessage(`${e.message || 'Progress is unavailable.'} Refresh status will be checked again.`); throw e; }
        }, { intervalMs: 5000 });
    }, [waiting, busy, contactId, receive]);
    async function refresh() {
        const requested = contactId, issue = ++generation.current;setBusy(true);setMessage('');
        try {
            const r = await fetch('/api/workspace/business-orders?' + new URLSearchParams({ contact_id: contactId }), { method: 'POST' }), b = await r.json();
            if (!r.ok) throw Error(b.error);if (!mounted.current || currentContact.current !== requested || issue !== generation.current) return;receive(b);
        } catch (e: any) { if (mounted.current && currentContact.current === requested && issue === generation.current) setMessage(e.message); }finally { if (mounted.current) setBusy(false); }
    }
    async function link() {
        const key = active.current;setBusy(true);setMessage('');
        try {
            const r = await fetch('/api/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'import_business_order', business_order_id: selected, seller_id: seller, deal_mode: dealMode, closed_deal_id: dealMode === 'existing' ? closedDealId : undefined }) }), b = await r.json();
            if (!r.ok) throw Error(b.error);if (active.current === key) onSaved(b.saved.id);
        } catch (e: any) { if (active.current === key) setMessage(e.message); }finally { setBusy(false); }
    }
    const order = data?.items?.find((o: any) => o.id === selected);
    return <section aria-label="Facebook Business Suite order" className="rounded border bg-slate-50 p-4 space-y-3">
        <h4 className="font-semibold">Create order in Facebook Business Suite</h4>
        <p className="text-sm">Create the client&apos;s order in Business Suite, then fetch it here. The invoice ID and total price come from the Page&apos;s Facebook order notice. This does not verify payment.</p>
        <div className="flex flex-wrap gap-4 text-sm">{data?.business_suite_url && <a className="underline" href={data.business_suite_url} target="_blank" rel="noreferrer">Open Facebook Business Suite</a>}<button type="button" disabled={busy} className="underline disabled:opacity-40" onClick={() => void refresh()}>Fetch Facebook orders</button></div>
        {message && <p role="status" className="text-sm rounded bg-amber-50 p-2">{message}</p>}
        {!!data?.items?.length && <><label className="block text-sm">Facebook order<select className="block w-full rounded border p-2" value={selected} onChange={e => setSelected(e.target.value)}><option value="">Choose the correct invoice</option>{data.items.map((o: any) => <option key={o.id} value={o.id}>Invoice {o.invoice_id} · {money(o.total_minor, o.currency)}{o.price_conflict ? ' · Price changed; review required' : ''}</option>)}</select></label>
            {order && <p className="text-sm">Total price from Facebook: <strong>{money(order.total_minor, order.currency)}</strong> · Observed {new Date(order.observed_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} PHT</p>}
            <button type="button" className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40" disabled={busy || !order || order.price_conflict || dealMode === 'existing' && !closedDealId} onClick={() => void link()}>Use this Facebook order</button></>}
        <p className="text-xs text-slate-500">Only available Page-authored order notices since launch are fetched. Missing order details remain unavailable. Customer messages, screenshots and typed amounts cannot become a Facebook order.</p>
    </section>;
}
