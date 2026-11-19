'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { requestDeadline } from '@/lib/request-deadline';
const field = 'block w-full rounded border border-slate-300 bg-white p-2 text-sm';
const count = (value: number | null) => value == null ? 'Unavailable' : new Intl.NumberFormat('en-PH').format(value);
const money = (value: number | null, currency: string) => value == null ? 'Unavailable' : new Intl.NumberFormat('en-PH', { style: 'currency', currency }).format(value / 100);
const stamp = (value: string | null) => value ? new Date(value).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) + ' PHT' : 'Not recorded';
export default function VeoBusinessInsights() {
    const [from, setFrom] = useState(''), [to, setTo] = useState(''), [page, setPage] = useState(''), [version, setVersion] = useState(0);
    const [data, setData] = useState<any>(null), [pages, setPages] = useState<any[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(true);
    const key = JSON.stringify([from, to, page, version]), current = data?.request_key === key ? data : null;
    useEffect(() => {
        const controller = new AbortController();setLoading(true);setError('');
        const params = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}), ...(page ? { page_id: page } : {}) });
        void requestDeadline(async signal => {
            const response = await fetch('/api/workspace/insights?' + params, { signal, cache: 'no-store' }), body = await response.json();
            if (!response.ok) throw Error(body.error || 'Business Insights unavailable');
            if (body.version !== 1 || !Array.isArray(body.money) || !Array.isArray(body.pages) || !body.readiness || !body.period || !body.backlog) throw Error('The report is incomplete. Refresh to retry.');
            return body;
        }, 20000, controller.signal).then(body => { if (!controller.signal.aborted) { setData({ ...body, request_key: key });if (!page) setPages(body.pages); } })
            .catch(failure => { if (!controller.signal.aborted) { setData(null);setError(failure.message); } })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [from, to, page, version]); // eslint-disable-line react-hooks/exhaustive-deps
    const ratio = current?.readiness.inquiries ? current.readiness.verified_ad_inquiries / current.readiness.inquiries : null;
    const cards = current ? [['Recorded inquiries', current.readiness.inquiries], ['Clients with payments', current.period.paying_clients], ['Orders with payments', current.period.paid_orders], ['Full-payment milestones', current.period.settlement_milestones], ['New orders', current.period.created_orders], ['Orders with refunds', current.period.refunded_orders]] : [];
    return <div className="space-y-5">
        <div className="flex flex-wrap justify-between gap-3"><div><h1 className="text-2xl font-bold">Business Insights</h1><p className="text-sm text-slate-600">Recorded results and the source coverage behind them.</p></div><button type="button" disabled={loading} className="rounded border bg-white px-3 py-2 text-sm disabled:opacity-40" onClick={() => setVersion(v => v + 1)}>Refresh insights</button></div>
        <div className="grid gap-3 rounded-xl border bg-white p-4 sm:grid-cols-3">
            <label className="text-sm">From (PHT)<input type="date" className={field} min={data?.launch_date} max={to || data?.to} value={from || data?.from || ''} onChange={event => setFrom(event.target.value)} /></label>
            <label className="text-sm">Through (PHT)<input type="date" className={field} min={from || data?.from} max={new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)} value={to || data?.to || ''} onChange={event => setTo(event.target.value)} /></label>
            <label className="text-sm">Page<select className={field} value={page} onChange={event => setPage(event.target.value)}><option value="">All assigned Pages</option>{pages.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        </div>
        {loading && <p role="status" className="text-sm">Loading insights…</p>}
        {error && <p role="alert" className="rounded border border-amber-200 bg-amber-50 p-4 text-sm">{error}</p>}
        {current && <>
            <p className="text-sm text-slate-600">Period: {current.from} through {current.to}. Checked {stamp(current.as_of)}.{current.provisional && ' Today is provisional.'} Money and work follow your seller branch and assigned Pages. Inquiry counts describe those Pages.</p>
            <section aria-label="Recorded period results" className="space-y-3"><h2 className="text-lg font-semibold">Selected-period activity</h2><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{cards.map(([label, value]) => <div key={String(label)} className="rounded-xl border bg-white p-4"><p className="text-sm text-slate-600">{label}</p><p className="text-2xl font-semibold">{count(value as number)}</p></div>)}</div><p className="text-xs text-slate-600">Multiple payments do not create extra buyers. Full-payment milestones are historical; later refunds can leave a current balance. Results cover recorded VEO activity since launch.</p></section>
            <section aria-label="Recorded money and balances" className="space-y-3 rounded-xl border bg-white p-4"><h2 className="text-lg font-semibold">Recorded cash and current balances</h2><p className="text-sm text-slate-600">Receipts and refunds use the selected payment dates. Balances are current across all visible orders since launch, regardless of the date filter. Currencies stay separate.</p>
                {!current.money.length ? <p className="text-sm">No recorded orders in this scope.</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{['Currency', 'Receipts in period', 'Refunds in period', 'Net receipts', 'Current balance', 'Orders with a balance'].map(label => <th key={label} className="whitespace-nowrap border-b p-2">{label}</th>)}</tr></thead><tbody>{current.money.map((row: any) => <tr key={row.currency}><td className="p-2 font-semibold">{row.currency}</td><td className="p-2">{money(row.received_minor, row.currency)}</td><td className="p-2">{money(row.refunds_minor, row.currency)}</td><td className="p-2">{money(row.net_cash_minor, row.currency)}</td><td className="p-2">{money(row.outstanding_minor, row.currency)}{row.balance_review_orders > 0 && <p className="text-xs text-amber-800">{row.balance_review_orders} orders need payment/refund review.</p>}</td><td className="p-2">{count(row.outstanding_orders)}</td></tr>)}</tbody></table></div>}
                <p className="text-xs text-slate-600">Cash uses recorded verified principal payments. Photos, pending reviews and tips are not extra principal. These figures are not profit or bank reconciliation; commission, ad spend and operating costs have not been subtracted. Existing order balance rules apply.</p>
            </section>
            <section aria-label="Current production backlog" className="space-y-3 rounded-xl border bg-white p-4"><h2 className="text-lg font-semibold">Current production backlog</h2><p className="text-sm">Working orders: <strong>{count(current.backlog.working_orders)}</strong> · Past the system deadline: <strong>{count(current.backlog.overdue_orders)}</strong> · Ready / waiting for payment: <strong>{count(current.backlog.ready_orders)}</strong></p><p className="text-sm">Oldest working order: {current.backlog.oldest_hours == null ? 'No recorded working orders' : Number(current.backlog.oldest_hours).toFixed(1) + ' hours since Close / first payment'}.</p>
                {current.backlog.oldest_orders.length > 0 && <ul className="space-y-2 text-sm">{current.backlog.oldest_orders.map((order: any) => <li key={order.id}><Link className="font-semibold underline" href={'/dashboard/workspace?view=receipts&contact_id=' + order.contact_id}>{order.contact_name || 'Client'}</Link> · {order.page_name} · {order.seller_name}<span className="block text-xs text-slate-600">System work due: {stamp(order.work_due_at)}{order.overdue ? ' · Overdue' : ''}</span></li>)}</ul>}
                <p className="text-xs text-slate-600">Current snapshot independent of period filters. The list shows the five oldest orders; totals include all matching orders. System work deadlines are separate from contractual payment due dates.</p>
            </section>
            <section aria-label="Data readiness" className="space-y-3 rounded-xl border bg-white p-4"><h2 className="text-lg font-semibold">Data readiness</h2><p className="text-sm">Verified originating ad: <strong>{count(current.readiness.verified_ad_inquiries)} of {count(current.readiness.inquiries)}</strong> period inquiries ({ratio == null ? 'rate unavailable' : new Intl.NumberFormat('en-PH', { style: 'percent', maximumFractionDigits: 1 }).format(ratio)}). Unknown or conflicting origins: <strong>{count(current.readiness.unknown_ad_inquiries)}</strong>.</p><p className="text-sm">{count(current.readiness.contacts_without_inquiry_date)} of {count(current.readiness.page_contacts)} Page contacts have no supported inquiry date. They are excluded from dated inquiry counts.</p>
                <details><summary className="cursor-pointer text-sm font-semibold">Contact identity sync checks</summary><ul className="mt-2 space-y-2 text-sm">{current.readiness.identity_checks.map((item: any) => <li key={item.page_id}>{item.page_name}: {stamp(item.checked_at)}{item.error && <span className="block text-amber-800">{item.error}</span>}</li>)}</ul><p className="mt-2 text-xs text-slate-600">Identity-sync attempts do not establish complete message, payment or ad-spend coverage.</p></details>
            </section>
            <nav aria-label="Detailed business reports" className="flex flex-wrap gap-4 text-sm"><Link className="underline" href="/dashboard/workspace?view=calendar">Calendar, earnings and commission</Link><Link className="underline" href="/dashboard/ad-quality">Advertising performance</Link><Link className="underline" href="/dashboard/workspace?view=sync">Collection health</Link></nav>
        </>}
    </div>;
}
