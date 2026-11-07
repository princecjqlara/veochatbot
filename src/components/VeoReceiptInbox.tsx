'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { receiptHoldLabels } from '@/lib/veo-receipts';
import VeoReceiptSaleDetails from './VeoReceiptSaleDetails';
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const field = 'block w-full rounded border border-slate-300 bg-white p-2 text-sm';
const money = (v: number | null, c: string | null) => v == null || !c ? 'Unverified' : new Intl.NumberFormat('en-PH', { style: 'currency', currency: c }).format(v / 100);
export default function VeoReceiptInbox({ scope, accounts, compact = false, initialContactId = '', initialKind = 'closed' }: { scope: any; accounts: any[]; compact?: boolean; initialContactId?: string; initialKind?: 'closed' | 'done' }) {
    const [data, setData] = useState<any>(null), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [version, setVersion] = useState(0);
    const [from, setFrom] = useState(() => new Date(Math.max(Date.parse(scope.launch_at), Date.now() - 29 * 86400000) + 8 * 3600000).toISOString().slice(0, 10)), [to, setTo] = useState(today), [worker, setWorker] = useState(''), [offset, setOffset] = useState(0);
    const [search, setSearch] = useState(''), [contacts, setContacts] = useState<any[]>([]), [picked, setPicked] = useState<any>(null), [client, setClient] = useState(initialContactId), [orders, setOrders] = useState<any[]>([]), [seller, setSeller] = useState(['manager', 'member'].includes(scope.role) ? scope.user_id : '');
    const [kind, setKind] = useState(initialKind), [order, setOrder] = useState(''), [links, setLinks] = useState<Record<string, string>>({}), [photos, setPhotos] = useState<Record<string, string>>({});
    const [payments, setPayments] = useState<any[]>([]), [loadingClient, setLoadingClient] = useState(false), [closedDeals, setClosedDeals] = useState<any[]>([]), [closedDeal, setClosedDeal] = useState('');
    const [dealMode, setDealMode] = useState<'' | 'new' | 'existing'>('');
    const openClosed = closedDeals.filter(d => d.seller_id === seller && (!d.order_id || !orders.find(o => o.id === d.order_id)?.done_at));
    const mode = dealMode || (!openClosed.length ? 'new' : '');
    const selectedClosed = mode === 'existing' ? closedDeals.find(d => d.seller_id === seller && order && d.order_id === order) || closedDeals.find(d => d.id === closedDeal && d.seller_id === seller) : undefined;
    const requestId = useRef(''), selling = accounts.filter(a => a.active !== false && ['manager', 'member'].includes(a.role));
    useEffect(() => { requestId.current = crypto.randomUUID(); }, [client, seller, kind, order, selectedClosed?.id, mode]);
    useEffect(() => {
        const c = new AbortController();
        fetch('/api/workspace/receipts?' + new URLSearchParams({ from, to, offset: String(offset), ...(worker ? { worker_id: worker } : {}) }), { cache: 'no-store', signal: c.signal }).then(async r => { const b = await r.json(); if (!r.ok) throw Error(b.error); setData(b); }).catch(e => { if (!c.signal.aborted) setMessage(e.message); });
        return () => c.abort();
    }, [from, to, worker, offset, version]);
    useEffect(() => {
        if (compact) return;
        const c = new AbortController(), timer = setTimeout(() => {
            void fetch('/api/workspace/contacts?' + new URLSearchParams({ search, offset: '0' }), { signal: c.signal }).then(async r => { const b = await r.json(); if (!r.ok) throw Error(b.error); setContacts(b.items || []); }).catch(e => { if (!c.signal.aborted) setMessage(e.message); });
        }, 250);
        return () => { clearTimeout(timer); c.abort(); };
    }, [search, compact]);
    useEffect(() => { setOrder(''); setPicked(null); setOrders([]); setPayments([]); setClosedDeals([]); setClosedDeal(''); setDealMode(''); }, [client]);
    useEffect(() => {
        if (!client) { setLoadingClient(false); return; } setLoadingClient(true);
        const c = new AbortController();
        void fetch('/api/workspace?contact_id=' + client, { cache: 'no-store', signal: c.signal }).then(async r => { const b = await r.json(); if (!r.ok) throw Error(b.error); if (!c.signal.aborted) { setOrders(b.orders || []); setPicked(b.contact); setPayments(b.payments || []); setClosedDeals(b.closed_deals || []); } }).catch(e => { if (!c.signal.aborted) { setPicked(null); setOrders([]); setPayments([]); setClosedDeals([]); setMessage(e.message); } }).finally(() => { if (!c.signal.aborted) setLoadingClient(false); });
        return () => c.abort();
    }, [client, version]);
    async function uploadReceipt(e: FormEvent<HTMLFormElement>) {
        e.preventDefault(); const form = e.currentTarget, body = new FormData(form); body.set('contact_id', client); body.set('seller_id', seller); body.set('receipt_kind', kind); body.set('request_id', requestId.current); if (order) body.set('order_id', order);
        body.set('deal_mode', mode);
        if (kind === 'closed') body.set('closed_occurred_at', new Date(String(body.get('closed_occurred_at')) + '+08:00').toISOString());
        if (kind === 'done' && selectedClosed) body.set('closed_deal_id', selectedClosed.id);
        setBusy(true); setMessage('');
        try { const r = await fetch('/api/workspace/receipts', { method: 'POST', body }); const b = await r.json(); if (!r.ok) throw Error(b.error); setMessage(b.saved.duplicate ? 'This receipt is already recorded; no duplicate sale or delivery was created. Its existing notes are retained; use Edit receipt notes to change them.' : b.saved.holds.length ? 'Receipt saved on hold. Complete the checklist below, then Recheck.' : 'Receipt saved and queued for Jaucian.'); requestId.current = crypto.randomUUID(); form.reset(); setVersion(v => v + 1); }
        catch (err: any) { setMessage(err.message); } finally { setBusy(false); }
    }
    async function recheck(id: string, selected?: string) {
        setBusy(true); setMessage('');
        try {
            const r = await fetch('/api/workspace/receipts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'recheck', receipt_id: id, order_id: selected || undefined }) });
            const b = await r.json(); if (!r.ok) throw Error(b.error);
            setMessage(b.holds?.length ? 'Rechecked. Complete the listed steps; salary remains on hold until the verified ledger qualifies.' : 'Rechecked. Eligible evidence is queued for Jaucian; each milestone is delivered once.'); setVersion(v => v + 1);
        } catch (e: any) { setMessage(e.message); } finally { setBusy(false); }
    }
    return <section aria-label="Receipt inbox and salary holds" className="rounded-xl border bg-white p-5 space-y-4">
        <div className="flex flex-wrap justify-between gap-3"><h2 className="text-xl font-bold">Receipts and salary on hold</h2><button className="text-sm underline" onClick={() => setVersion(v => v + 1)}>Recheck list</button></div>
        <p className="text-sm">Closed Deal: submit the receipt with the lead stage Qualified or Converted; no order is required. Done Deal: a Qualified or Converted lead, created order and reconciled verified payments are required. The Closed Deal amount plus additional payments must match the deal price within ₱2 for PHP; other currencies must match exactly. Uploading evidence alone does not earn salary.</p>
        <p className="text-xs text-slate-500">Jaucian reminds the mapped team about outstanding steps in its scheduled updates. Only eligible receipts go to Telegram. Photos are private and expire after seven days; expired evidence requires re-upload. Financial history remains retained.</p>
        {compact && <Link className="underline text-sm" href="/dashboard/workspace?view=receipts">Open Receipts to submit a Closed or Done Deal photo</Link>}
        {message && <p role="status" className="rounded border bg-amber-50 p-3 text-sm">{message}</p>}
        {!compact && <><div className="grid gap-3 rounded border p-4 md:grid-cols-2">
            <label className="text-sm">Find client<input className={field} value={search} onChange={e => setSearch(e.target.value)} placeholder="Search client name, ID or saved details" /></label>
            <label className="text-sm">Client<select required className={field} value={client} onChange={e => setClient(e.target.value)}><option value="">Choose a client</option>{(picked && !contacts.some(c => c.id === picked.id) ? [picked, ...contacts] : contacts).map(c => <option key={c.id} value={c.id}>{c.name || 'Unknown client'} · {c.page_name || 'Assigned Page'}</option>)}</select></label>
            <label className="text-sm">Seller<select required className={field} value={seller} onChange={e => { setSeller(e.target.value); setOrder(''); setClosedDeal(''); setDealMode(''); }}><option value="">Choose a selling worker</option>{selling.map(a => <option key={a.id} value={a.id}>{a.name} · {a.role}</option>)}</select></label>
            <label className="text-sm">Receipt type<select className={field} value={kind} onChange={e => { setKind(e.target.value as 'closed' | 'done'); if (e.target.value === 'closed') { setDealMode('new');setClosedDeal('');setOrder(''); } }}><option value="closed">Closed Deal receipt</option><option value="done">Done Deal receipt</option></select></label>
            <label className="text-sm">Order ({kind === 'closed' ? 'not required for Closed Deals' : 'required to qualify as Done'})<select className={field} value={order} onChange={e => { const id = e.target.value,d = closedDeals.find(d => d.order_id === id && d.seller_id === seller);setOrder(id);setClosedDeal(d?.id || '');if (d) { setDealMode('existing');setKind('done'); } }}><option value="">{kind === 'closed' ? 'No order needed' : 'Choose or fetch a Facebook order below'}</option>{orders.filter(o => o.seller_id === seller && (mode !== 'new' || !closedDeals.some(d => d.order_id === o.id))).map(o => <option key={o.id} value={o.id}>{o.description} · {money(o.total_minor, o.currency)}</option>)}</select></label>
        </div>
        {picked && !loadingClient && !!openClosed.length && <section aria-label="Choose new or existing deal" className="rounded border bg-blue-50 p-4 space-y-3"><h3 className="font-semibold">This client has {openClosed.length} Closed Deal(s) waiting to finish</h3><div className="flex flex-wrap gap-4 text-sm"><label className="flex gap-2"><input type="radio" name="deal_mode" checked={mode === 'new'} onChange={() => { setDealMode('new');setClosedDeal('');setOrder(''); }} />New deal</label><label className="flex gap-2"><input type="radio" name="deal_mode" checked={mode === 'existing'} onChange={() => { setDealMode('existing');setKind('done');setOrder('');setClosedDeal(openClosed.length === 1 ? openClosed[0].id : '');if (openClosed.length === 1 && openClosed[0].order_id) setOrder(openClosed[0].order_id); }} />Complete existing Closed Deal</label></div>
        {mode === 'existing' && <label className="block text-sm">Closed Deal to complete<select className={field} value={selectedClosed?.id || ''} onChange={e => { const d = openClosed.find(d => d.id === e.target.value);setClosedDeal(e.target.value);setOrder(d?.order_id || ''); }}><option value="">Choose the earlier deal</option>{openClosed.map(d => <option key={d.id} value={d.id}>{money(d.amount_minor,d.currency)} · {new Date(d.occurred_at).toLocaleString('en-PH',{timeZone:'Asia/Manila'})}</option>)}</select></label>}
        {mode === 'new' && <p className="text-xs">This sale stays separate from the earlier Closed Deals. Choose Closed for a new deposit or Done for immediate settlement.</p>}</section>}
        <VeoReceiptSaleDetails contact={mode && (mode === 'new' || selectedClosed) ? picked : null} seller={seller} order={orders.find(o => o.id === order && o.seller_id === seller)} payments={payments} closedDeals={mode === 'existing' ? closedDeals.filter(d => d.seller_id === seller) : []} closedDealId={selectedClosed?.id || ''} onClosedChange={id => { setClosedDeal(id); const d = closedDeals.find(d => d.id === id);setOrder(d?.order_id || ''); }} dealMode={mode || 'new'} kind={kind} version={version} loading={loadingClient} onSaved={id => { setOrder(id); setVersion(v => v + 1); }} />
        <form key={`${client}:${seller}:${kind}:${order}:${selectedClosed?.id || ''}`} className="grid gap-3 rounded border p-4 md:grid-cols-2" onSubmit={e => void uploadReceipt(e)}>
            {kind === 'closed' && <><label className="text-sm">Closed Deal payment amount<input required name="closed_amount" inputMode="decimal" className={field} placeholder="0.00" /></label><label className="text-sm">Closed Deal currency<input required name="closed_currency" pattern="[A-Za-z]{3}" defaultValue="PHP" className={field} /></label><label className="text-sm">Closed Deal payment time (PHT)<input required name="closed_occurred_at" type="datetime-local" defaultValue={new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16)} className={field} /></label><p className="text-xs self-center">This records the receipt amount for later reconciliation. It does not create an order or a verified financial payment.</p></>}
            <label className="text-sm">Receipt / conversation photo<input required className={field} name="photo" type="file" accept="image/jpeg,image/png,image/webp" onChange={() => { requestId.current = crypto.randomUUID(); }} /></label>
            <label className="text-sm">Receipt notes (optional)<textarea name="notes" className={field} maxLength={2000} rows={3} placeholder="Payment context, client instructions, or steps still pending" /></label>
            <button disabled={busy || !client || !seller || !mode || mode === 'existing' && !selectedClosed} className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-40 md:col-span-2">Submit receipt evidence</button>
        </form></>}
        <div className="flex flex-wrap gap-3"><label className="text-sm">From<input className={field} type="date" value={from} max={to} onChange={e => { setFrom(e.target.value); setOffset(0); }} /></label><label className="text-sm">Through<input className={field} type="date" value={to} min={from} max={today()} onChange={e => { setTo(e.target.value); setOffset(0); }} /></label>{scope.role !== 'member' && <label className="text-sm">Employee<select className={field} value={worker} onChange={e => { setWorker(e.target.value); setOffset(0); }}><option value="">All staff in your branch</option>{accounts.filter(a => ['member', 'manager'].includes(a.role)).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}</div>
        {!data && <p className="text-sm">Loading receipt evidence…</p>}
        {data && !data.items.length && <p className="text-sm text-slate-500">No receipt evidence in these dates. Verified salary is shown separately in Salary.</p>}
        {(data?.items || []).map((r: any) => <article key={r.id} className={`rounded border p-4 space-y-2 ${r.salary_status === 'on_hold' ? 'border-amber-300 bg-amber-50' : 'bg-slate-50'}`}>
            <div className="flex flex-wrap justify-between gap-2"><Link className="font-semibold underline" href={`/dashboard/contacts/${r.contact_id}?pageId=${r.page_id}`}>{r.contact_name || 'Unknown client'}</Link><span className="text-xs">{r.receipt_kind === 'closed' ? 'Closed Deal receipt' : 'Done Deal receipt'} · {r.seller_name} · {r.page_name}</span></div>
            <p className="text-sm font-semibold">Salary: {r.salary_status === 'on_hold' ? 'ON HOLD' : 'Eligible in the verified ledger — see Salary'} · Telegram: {r.delivery_status.replaceAll('_', ' ')}</p>
            {r.receipt_kind === 'closed' && r.closed_deal_id && <p className="text-sm">Closed Deal: {['qualified', 'converted'].includes(r.lead_stage) ? 'Stage qualified; no order required. Counted once as a Closed Deal.' : 'Waiting for the lead stage to be Qualified or Converted.'} Any order/payment steps below apply to Salary and Done Deal completion.</p>}
            <p className="text-sm">Lead: {r.lead_stage || 'Unknown'} · Order: {r.order_description || 'Not created / linked'} · Verified payment: {money(r.paid_minor, r.currency)} / {money(r.total_minor, r.currency)}</p>
            {r.closed_amount_minor != null && <p className="text-sm">Closed Deal receipt amount: {money(r.closed_amount_minor, r.currency)} · {r.closed_payment_verified ? 'Reconciled against verified payment records' : 'Pending financial verification / reconciliation'}</p>}
            {r.receipt_kind === 'done' && <p className="text-sm">Balance paid: <strong>{money(r.done_balance_paid_minor, r.currency)}</strong> · Total price: <strong>{money(r.total_minor, r.currency)}</strong></p>}
            {r.receipt_kind === 'done' && r.settlement_difference_minor != null && <p className="text-sm">Payment difference from deal price: {money(r.settlement_difference_minor, r.currency)} · maximum allowed difference: {money(r.settlement_tolerance_minor, r.currency)}</p>}
            <p className="text-sm whitespace-pre-wrap">Notes: {r.notes || 'None recorded'}</p>
            <details><summary className="cursor-pointer text-sm underline">Edit receipt notes</summary><form key={`${r.id}:${r.notes || ''}`} className="space-y-2 mt-2" onSubmit={async e => {
                e.preventDefault(); const notes = String(new FormData(e.currentTarget).get('notes') || ''); setBusy(true); setMessage('');
                try { const res = await fetch('/api/workspace/receipts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'notes', receipt_id: r.id, notes }) }), b = await res.json(); if (!res.ok) throw Error(b.error); setMessage('Receipt notes saved. Financial records are unchanged.'); setVersion(v => v + 1); } catch (err: any) { setMessage(err.message); } finally { setBusy(false); }
            }}><textarea aria-label="Edit receipt notes" className={field} name="notes" rows={3} maxLength={2000} defaultValue={r.notes || ''} /><button className="text-sm underline disabled:opacity-40" disabled={busy}>Save receipt notes</button></form></details>
            {!!r.salary_holds.length && <ul className="text-sm list-disc pl-5">{r.salary_holds.map((key: string) => <li key={key}>{receiptHoldLabels[key] || key}</li>)}</ul>}
            {r.holds.filter((key: string) => !r.salary_holds.includes(key)).map((key: string) => <p className="text-xs" key={key}>{receiptHoldLabels[key] || key}</p>)}
            {r.last_error && <p className="text-xs">{r.last_error}</p>}
            {!r.order_id && <label className="block text-sm">Link the created order<select className={field} value={links[r.id] || ''} onChange={e => setLinks(old => ({ ...old, [r.id]: e.target.value }))}><option value="">Choose the matching order</option>{r.order_options.map((o: any) => <option key={o.id} value={o.id}>{o.description} · {money(o.total_minor, o.currency)}</option>)}</select></label>}
            <div className="flex gap-4 text-sm"><button disabled={busy} className="underline disabled:opacity-40" onClick={() => void recheck(r.id, links[r.id])}>Recheck receipt and salary eligibility</button>{r.photo_available && <button className="underline" onClick={async () => { try { const res = await fetch(`/api/workspace/receipts?receipt_id=${r.id}&preview=1`, { cache: 'no-store' }), b = await res.json(); if (!res.ok) throw Error(b.error); setPhotos(old => ({ ...old, [r.id]: b.photo_url })); } catch (e: any) { setMessage(e.message); } }}>View private photo</button>}</div>
            {photos[r.id] && <img className="max-h-80 max-w-full object-contain" src={photos[r.id]} alt="Privately submitted receipt evidence" />}
        </article>)}
        {!!data?.total && <div className="flex justify-between text-sm"><button disabled={!offset} className="underline disabled:opacity-40" onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button><span>{data.total} receipts</span><button disabled={offset + 50 >= data.total} className="underline disabled:opacity-40" onClick={() => setOffset(offset + 50)}>Next</button></div>}
    </section>;
}
