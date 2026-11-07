'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import VeoBusinessOrderPicker from './VeoBusinessOrderPicker';
import { parseMoneyMinor } from '@/lib/money-minor';
const field = 'block w-full rounded border border-slate-300 bg-white p-2 text-sm';
const button = 'rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40';
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const localTime = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16);
const money = (v: number, c: string) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: c }).format(v / 100);
const stage = (v?: string) => v ? v.replaceAll('_', ' ').replace(/\b\w/g, m => m.toUpperCase()) : 'Unknown';

export default function VeoReceiptSaleDetails({ contact, seller, order, payments = [], closedDeals = [], closedDealId = '', onClosedChange, dealMode = 'new', kind, version, loading, onSaved }: {
    contact: any; seller: string; order: any; payments?: any[]; closedDeals?: any[]; closedDealId?: string; onClosedChange?: (id: string) => void; dealMode?: 'new' | 'existing'; kind: string; version: number; loading: boolean; onSaved: (orderId: string) => void;
}) {
    const [commission, setCommission] = useState<any>(null), [commissionError, setCommissionError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
    const requests = useRef(new Map<string, string>()), day = today();
    const context = `${contact?.id || ''}:${seller}:${order?.id || ''}:${closedDealId}`, activeContext = useRef(context); activeContext.current = context;
    const closed = closedDeals.find(d => d.id === closedDealId), availableClosed = closedDeals.filter(d => !d.order_id || d.order_id === order?.id);
    const settled = order?.done_at && Math.abs(Number(order.paid_minor) - Number(order.total_minor)) <= Number(order.settlement_tolerance_minor || 0);
    const previous = Number(order?.paid_minor || 0), unverifiedClosed = closed && !closed.verified_payment_id && previous === 0 ? Number(closed.amount_minor) : 0;
    const [balancePaid, setBalancePaid] = useState('');
    useEffect(() => { setBalancePaid(order ? (Math.max(0, order.total_minor - previous - unverifiedClosed) / 100).toFixed(2) : ''); }, [order?.id, order?.total_minor, previous, unverifiedClosed]);
    let paidNow: number | null = null;try { paidNow = /^0(?:\.0{1,2})?$/.test(balancePaid.trim()) ? 0 : parseMoneyMinor(balancePaid); } catch { /* Incomplete input. */ }
    const closedSelect = <label className="text-sm md:col-span-2">Earlier Closed Deal<select name="closed_deal_id" className={field} value={closedDealId} disabled={!!closed?.order_id} onChange={e => onClosedChange?.(e.target.value)}><option value="">No earlier Closed Deal / immediate full payment</option>{availableClosed.map(d => <option key={d.id} value={d.id}>{money(d.amount_minor, d.currency)} · {new Date(d.occurred_at).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' })}</option>)}</select>{closed?.order_id && <input type="hidden" name="closed_deal_id" value={closed.id} />}</label>;
    useEffect(() => {
        setCommission(null); setCommissionError(''); if (!seller) return;
        const controller = new AbortController();
        void fetch('/api/workspace/receipts?' + new URLSearchParams({ commission: '1', worker_id: seller, date: day }), { cache: 'no-store', signal: controller.signal }).then(async r => {
            const b = await r.json(); if (!r.ok) throw Error(b.error); if (!controller.signal.aborted) setCommission(b);
        }).catch(e => { if (!controller.signal.aborted) setCommissionError(e.message); });
        return () => controller.abort();
    }, [seller, day, version]);
    useEffect(() => { setMessage(''); }, [contact?.id, seller, order?.id]);
    async function save(e: FormEvent<HTMLFormElement>) {
        e.preventDefault(); const form = e.currentTarget, fields = Object.fromEntries(new FormData(form));
        const payload = { ...fields, action: 'payment', order_id: order.id, settle_done: true, confirmed: fields.confirmed === 'on', confirm_converted: fields.confirm_converted === 'on', occurred_at: new Date(String(fields.occurred_at) + '+08:00').toISOString() };
        const key = JSON.stringify(payload); if (!requests.current.has(key)) requests.current.set(key, crypto.randomUUID());
        setBusy(true); setMessage('');
        try {
            const r = await fetch('/api/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, request_id: requests.current.get(key) }) });
            const b = await r.json(); if (!r.ok) throw Error(b.error);
            requests.current.delete(key); if (activeContext.current !== context) return; onSaved(order.id);
            setMessage('Verified balance payment saved. Order balance, lead stage and commission are being refreshed. Recheck any earlier receipt.');form.reset();
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
                {(commission.totals || []).map((t: any) => <div key={t.currency} className="rounded border bg-white p-3 text-sm"><p>Eligible fully paid sales: <strong>{money(t.gross_minor, t.currency)}</strong></p><p>Current commission at {commission.rate}%: <strong>{money(t.commission_minor, t.currency)}</strong></p><p>At 35% if either quota is missed: {money(Math.floor(t.gross_minor * 35 / 100), t.currency)} (estimate)</p><p>At 40% if both quotas are reached: {money(Math.floor(t.gross_minor * 40 / 100), t.currency)} (estimate)</p></div>)}
                {!commission.totals?.length && <p className="text-sm">0 recorded commission. No eligible fully paid sales for this date.</p>}
                <p className="text-xs text-slate-600">{commission.provisional ? 'Provisional until Philippine midnight. The final daily rate applies to eligible completed orders for this date.' : 'Completed Philippine work date.'} A Qualified or Converted Closed Deal can count without an order; commission still requires a created order and verified settlement. <Link className="underline" href="/dashboard/workspace?view=salary">Open daily Salary history</Link></p>
            </>}
        </section>}
        {loading && <p className="text-sm" role="status">Refreshing client stage, deal price and payments…</p>}
        {contact && !loading && <section aria-label="Selected client deal and payment" className="rounded border p-4 space-y-3">
            <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{contact.name || 'Unknown client'} · Current lead stage: {stage(contact.pipeline_stage)}</h3><Link className="text-sm underline" href={`/dashboard/contacts/${contact.id}?pageId=${contact.page_id}`}>Open contact / update lead stage</Link></div>
            {message && <p role="status" className="rounded bg-amber-50 p-3 text-sm">{message}</p>}
            {kind === 'closed' && <p className="rounded bg-slate-50 p-3 text-sm">No order is required for a Closed Deal. Set the lead to Qualified or Converted, then submit the receipt and its payment amount below. The amount is financially verified when reconciling the Done Deal.</p>}
            {!order && seller && kind === 'done' && <VeoBusinessOrderPicker contactId={contact.id} seller={seller} closedDealId={closedDealId} dealMode={dealMode} onSaved={onSaved} />}
            {order && <>
                <div className="grid gap-2 rounded bg-slate-50 p-3 text-sm sm:grid-cols-3"><p>Total price: <strong>{money(order.total_minor, order.currency)}</strong></p><p>Verified payments: <strong>{money(order.paid_minor, order.currency)}</strong></p><p>Remaining balance: <strong>{money(settled ? 0 : Math.max(0, order.total_minor - order.paid_minor), order.currency)}</strong></p></div>
                <p className="text-xs">Potential commission after a Qualified or Converted lead and verified settlement: {money(Math.floor(order.total_minor * 35 / 100), order.currency)} at 35%, or {money(Math.floor(order.total_minor * 40 / 100), order.currency)} at 40%. Final earnings use actual verified net payments and that day&apos;s two quotas. Refunds and corrections can adjust earnings.</p>
                {payments.some(p => p.order_id === order.id) && <details><summary className="cursor-pointer text-sm">Saved payments for this order</summary>{payments.filter(p => p.order_id === order.id).map(p => <p className="text-xs py-1" key={p.id}>{p.kind} · {money(p.amount_minor, order.currency)} · {new Date(p.occurred_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} PHT · {p.reference}</p>)}</details>}
                {kind === 'done' && <form key={`payment:${order.id}:${order.paid_minor}:${closedDealId}`} className="grid gap-3 border-t pt-3 md:grid-cols-2" onSubmit={e => void save(e)}>
                    <h4 className="font-semibold md:col-span-2">Reconcile Closed Deal and final payment</h4>
                    {availableClosed.length > 0 && closedSelect}
                    {closed && <p className="text-sm md:col-span-2">Earlier Closed Deal amount: <strong>{money(closed.amount_minor, closed.currency)}</strong>. {closed.verified_payment_id ? 'Already included in the verified payments above.' : 'Verify this receipt amount together with the additional payment.'}</p>}
                    <p className="text-xs md:col-span-2">The combined verified payments must match the deal price within {order.currency === 'PHP' ? '₱2' : 'zero difference'}. Previously saved payments are counted once. Enter 0 additional payment if the saved receipts already cover the price.</p>
                    {closed && !closed.verified_payment_id && Number(order.paid_minor) > 0 && <label className="text-sm md:col-span-2">Saved payment covering the Closed Deal<select name="existing_closed_payment_id" className={field}><option value="">Choose the existing payment; do not add it again</option>{payments.filter(p => p.order_id === order.id && p.kind !== 'refund' && Number(p.amount_minor) >= Number(closed.amount_minor)).map(p => <option key={p.id} value={p.id}>{p.reference} · {money(p.amount_minor, order.currency)}</option>)}</select></label>}
                    <input name="kind" type="hidden" value="balance" />
                    <label className="text-sm">Balance paid ({order.currency})<input name="amount" required inputMode="decimal" value={balancePaid} onChange={e => setBalancePaid(e.target.value)} className={field} /></label>
                    {paidNow != null && <p className="rounded bg-slate-50 p-3 text-sm md:col-span-2">Earlier verified payments {money(previous, order.currency)} + Closed Deal awaiting verification {money(unverifiedClosed, order.currency)} + balance paid {money(paidNow, order.currency)} = {money(previous + unverifiedClosed + paidNow, order.currency)}. Total price: {money(order.total_minor, order.currency)}. Difference: {money(previous + unverifiedClosed + paidNow - order.total_minor, order.currency)}.</p>}
                    <label className="text-sm">Payment time (PHT)<input name="occurred_at" type="datetime-local" required defaultValue={localTime()} className={field} /></label>
                    <label className="text-sm">Transaction reference<input name="reference" required minLength={3} maxLength={160} className={field} /></label>
                    <label className="flex gap-2 text-sm md:col-span-2"><input name="confirmed" type="checkbox" required />I verified the Closed Deal amount and additional payment against the actual payment records.</label>
                    {!['qualified', 'converted'].includes(contact.pipeline_stage) && <label className="flex gap-2 text-sm md:col-span-2"><input name="confirm_converted" type="checkbox" />I also confirm this lead is Converted. Save that lead stage with this verified payment.</label>}
                    <button disabled={busy} className={button}>Reconcile payments and mark Done</button>
                </form>}
            </>}
        </section>}
    </div>;
}
