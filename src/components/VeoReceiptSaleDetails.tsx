'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
const field = 'block w-full rounded border border-slate-300 bg-white p-2 text-sm';
const button = 'rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40';
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const localTime = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16);
const money = (v: number, c: string) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: c }).format(v / 100);
const stage = (v?: string) => v ? v.replaceAll('_', ' ').replace(/\b\w/g, m => m.toUpperCase()) : 'Unknown';

export default function VeoReceiptSaleDetails({ contact, seller, order, payments = [], kind, version, loading, onSaved }: {
    contact: any; seller: string; order: any; payments?: any[]; kind: string; version: number; loading: boolean; onSaved: (orderId: string) => void;
}) {
    const [commission, setCommission] = useState<any>(null), [commissionError, setCommissionError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
    const requests = useRef(new Map<string, string>()), day = today();
    const context = `${contact?.id || ''}:${seller}:${order?.id || ''}`, activeContext = useRef(context); activeContext.current = context;
    useEffect(() => {
        setCommission(null); setCommissionError(''); if (!seller) return;
        const controller = new AbortController();
        void fetch('/api/workspace/receipts?' + new URLSearchParams({ commission: '1', worker_id: seller, date: day }), { cache: 'no-store', signal: controller.signal }).then(async r => {
            const b = await r.json(); if (!r.ok) throw Error(b.error); if (!controller.signal.aborted) setCommission(b);
        }).catch(e => { if (!controller.signal.aborted) setCommissionError(e.message); });
        return () => controller.abort();
    }, [seller, day, version]);
    useEffect(() => { setMessage(''); }, [contact?.id, seller, order?.id]);
    async function save(e: FormEvent<HTMLFormElement>, action: 'order' | 'payment') {
        e.preventDefault(); const form = e.currentTarget, fields = Object.fromEntries(new FormData(form));
        const payload = action === 'order' ? { ...fields, action, page_id: contact.page_id, contact_id: contact.id, seller_id: seller }
            : { ...fields, action, order_id: order.id, confirmed: fields.confirmed === 'on', confirm_converted: fields.confirm_converted === 'on', occurred_at: new Date(String(fields.occurred_at) + '+08:00').toISOString() };
        const key = JSON.stringify(payload); if (!requests.current.has(key)) requests.current.set(key, crypto.randomUUID());
        setBusy(true); setMessage('');
        try {
            const r = await fetch('/api/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, request_id: requests.current.get(key) }) });
            const b = await r.json(); if (!r.ok) throw Error(b.error);
            requests.current.delete(key); if (activeContext.current !== context) return; onSaved(action === 'order' ? b.saved.id : order.id);
            setMessage(action === 'order' ? 'Deal price saved in the new order. Record the actual payment separately, then upload the receipt.' : 'Verified payment saved. Order balance, lead stage and commission are being refreshed. Recheck any earlier receipt.');
            if (action === 'payment') form.reset();
        } catch (e: any) { if (activeContext.current === context) setMessage(e.message + ' Recheck the order and payment history before retrying; unchanged retries use the same request ID.'); }
        finally { setBusy(false); }
    }
    return <div className="space-y-4">
        {seller && <section aria-label="Seller daily commission and quota" className="rounded border bg-slate-50 p-4 space-y-2">
            <h3 className="font-semibold">Daily commission and quota · {day} PHT</h3>
            <p className="text-xs">Both the Closed Deal quota and Done Deal quota must be reached for 40%; otherwise the rate is 35%. Qualification includes all worker Pages; sales and earnings below follow your current Page access.</p>
            {commissionError && <p role="alert" className="text-sm text-amber-800">Commission unavailable: {commissionError}</p>}
            {!commission && !commissionError && <p className="text-sm">Loading verified commission…</p>}
            {commission && <>
                <div className="flex flex-wrap gap-4 text-sm"><p>Closed Deals: <strong>{commission.closed} / {commission.target}</strong></p><p>Done Deals: <strong>{commission.done} / {commission.target}</strong></p><p className="font-semibold">{commission.rate === 40 ? 'Both quotas reached · 40%' : 'Quota not yet reached · 35%'}</p></div>
                {commission.rate !== 40 && <p className="text-sm">Still needed: {Math.max(0, commission.target - commission.closed)} Closed Deals and {Math.max(0, commission.target - commission.done)} Done Deals.</p>}
                {(commission.totals || []).map((t: any) => <div key={t.currency} className="rounded border bg-white p-3 text-sm"><p>Eligible fully paid sales: <strong>{money(t.gross_minor, t.currency)}</strong></p><p>Current commission at {commission.rate}%: <strong>{money(t.commission_minor, t.currency)}</strong></p><p>At 35% if either quota is missed: {money(Math.floor(t.gross_minor * .35), t.currency)}</p><p>At 40% if both quotas are reached: {money(Math.floor(t.gross_minor * .40), t.currency)}</p></div>)}
                {!commission.totals?.length && <p className="text-sm">0 recorded commission. No eligible fully paid sales for this date.</p>}
                <p className="text-xs text-slate-600">{commission.provisional ? 'Provisional until Philippine midnight. The final daily rate applies to all eligible fully paid order totals for this date.' : 'Completed Philippine work date.'} Deposits and receipt uploads alone do not earn commission. <Link className="underline" href="/dashboard/workspace?view=salary">Open daily Salary history</Link></p>
            </>}
        </section>}
        {loading && <p className="text-sm" role="status">Refreshing client stage, deal price and payments…</p>}
        {contact && !loading && <section aria-label="Selected client deal and payment" className="rounded border p-4 space-y-3">
            <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{contact.name || 'Unknown client'} · Current lead stage: {stage(contact.pipeline_stage)}</h3><Link className="text-sm underline" href={`/dashboard/contacts/${contact.id}?pageId=${contact.page_id}`}>Open contact / update lead stage</Link></div>
            {message && <p role="status" className="rounded bg-amber-50 p-3 text-sm">{message}</p>}
            {!order && seller && <form key={`order:${contact.id}:${seller}`} className="grid gap-3 md:grid-cols-2" onSubmit={e => void save(e, 'order')}>
                <h4 className="font-semibold md:col-span-2">Create the deal / order</h4>
                <p className="text-xs md:col-span-2">Choose an existing order above, or save a new deal price here. A receipt can also be uploaded on hold before an order is created.</p>
                <label className="text-sm md:col-span-2">Deal / offer details<input name="description" required maxLength={500} className={field} /></label>
                <label className="text-sm">Deal price<input name="amount" required inputMode="decimal" placeholder="0.00" className={field} /></label>
                <label className="text-sm">Currency<input name="currency" required defaultValue="PHP" pattern="[A-Za-z]{3}" className={field} /></label>
                <button disabled={busy} className={button}>Save deal and create order</button>
            </form>}
            {order && <>
                <div className="grid gap-2 rounded bg-slate-50 p-3 text-sm sm:grid-cols-3"><p>Deal price: <strong>{money(order.total_minor, order.currency)}</strong></p><p>Verified payments: <strong>{money(order.paid_minor, order.currency)}</strong></p><p>Remaining balance: <strong>{money(Math.max(0, order.total_minor - order.paid_minor), order.currency)}</strong></p></div>
                <p className="text-xs">Potential commission on this deal after Converted status and verified full payment: {money(Math.floor(order.total_minor * .35), order.currency)} at 35%, or {money(Math.floor(order.total_minor * .40), order.currency)} at 40%. The actual rate uses the full-payment Philippine date and that day&apos;s two quotas. Refunds and corrections can adjust earnings.</p>
                {payments.some(p => p.order_id === order.id) && <details><summary className="cursor-pointer text-sm">Saved payments for this order</summary>{payments.filter(p => p.order_id === order.id).map(p => <p className="text-xs py-1" key={p.id}>{p.kind} · {money(p.amount_minor, order.currency)} · {new Date(p.occurred_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} PHT · {p.reference}</p>)}</details>}
                {Number(order.paid_minor) < Number(order.total_minor) ? <form key={`payment:${order.id}:${order.paid_minor}:${kind}`} className="grid gap-3 border-t pt-3 md:grid-cols-2" onSubmit={e => void save(e, 'payment')}>
                    <h4 className="font-semibold md:col-span-2">Record the amount actually paid</h4>
                    <label className="text-sm">Payment type<select name="kind" className={field} defaultValue={kind === 'closed' ? 'deposit' : Number(order.paid_minor) > 0 ? 'balance' : 'full'}><option value="deposit">Down payment / Closed Deal</option><option value="balance">Balance payment</option><option value="full">Immediate full payment</option></select></label>
                    <label className="text-sm">Payment amount ({order.currency})<input name="amount" required inputMode="decimal" defaultValue={kind === 'closed' ? '' : ((order.total_minor - order.paid_minor) / 100).toFixed(2)} className={field} /></label>
                    <label className="text-sm">Payment time (PHT)<input name="occurred_at" type="datetime-local" required defaultValue={localTime()} className={field} /></label>
                    <label className="text-sm">Transaction reference<input name="reference" required minLength={3} maxLength={160} className={field} /></label>
                    <label className="flex gap-2 text-sm md:col-span-2"><input name="confirmed" type="checkbox" required />I verified this amount against the actual payment record.</label>
                    {contact.pipeline_stage !== 'converted' && <label className="flex gap-2 text-sm md:col-span-2"><input name="confirm_converted" type="checkbox" />I also confirm this lead is Converted. Save that lead stage with this verified payment.</label>}
                    <button disabled={busy} className={button}>Save verified payment</button>
                </form> : <p className="text-sm font-semibold">Order fully paid in the verified ledger.{contact.pipeline_stage !== 'converted' && ' Salary remains on hold until the lead is Converted.'}</p>}
            </>}
        </section>}
    </div>;
}
