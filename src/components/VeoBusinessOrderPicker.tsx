'use client';
import { useEffect, useRef, useState } from 'react';
const money = (n: number, currency: string) => new Intl.NumberFormat('en-PH', { style: 'currency', currency }).format(n / 100);
export default function VeoBusinessOrderPicker({ contactId, seller, closedDealId, dealMode, onSaved }: {
    contactId: string; seller: string; closedDealId: string; dealMode: 'new' | 'existing'; onSaved: (id: string) => void;
}) {
    const [data, setData] = useState<any>(null), [selected, setSelected] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
    const active = useRef('');active.current = `${contactId}:${seller}:${closedDealId}:${dealMode}`;
    useEffect(() => {
        setData(null);setSelected('');setMessage('');const c = new AbortController();
        void fetch('/api/workspace/business-orders?' + new URLSearchParams({ contact_id: contactId }), { cache: 'no-store', signal: c.signal }).then(async r => {
            const b = await r.json();if (!r.ok) throw Error(b.error);if (!c.signal.aborted) setData(b);
        }).catch(e => { if (!c.signal.aborted) setMessage(e.message); });
        return () => c.abort();
    }, [contactId]);
    async function refresh() {
        const key = active.current;setBusy(true);setMessage('');
        try {
            const r = await fetch('/api/workspace/business-orders?' + new URLSearchParams({ contact_id: contactId }), { method: 'POST' }), b = await r.json();
            if (!r.ok) throw Error(b.error);if (active.current !== key) return;setData(b);
            setMessage(b.items.length ? b.scan.coverage : 'No accessible order notice with an invoice ID and total was returned. Create the order in Business Suite, then fetch again. Meta may not expose every order.');
        } catch (e: any) { if (active.current === key) setMessage(e.message); }finally { setBusy(false); }
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
