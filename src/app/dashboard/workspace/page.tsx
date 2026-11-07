'use client';
import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import VeoWorkspaceContacts, { type WorkspaceContact } from '@/components/VeoWorkspaceContacts';
import VeoTeamsDashboard from '@/components/VeoTeamsDashboard';
import VeoCapacitySummary from '@/components/VeoCapacitySummary';
import VeoTelegramProfile from '@/components/VeoTelegramProfile';
import VeoJaucianIntegration from '@/components/VeoJaucianIntegration';
import VeoOperationsPanel from '@/components/VeoOperationsPanel';
import VeoWorkCalendar from '@/components/VeoWorkCalendar';
import VeoStaffOffboarding from '@/components/VeoStaffOffboarding';
import VeoPageBudget from '@/components/VeoPageBudget';
import VeoReceiptInbox from '@/components/VeoReceiptInbox';
import VeoStaffWarnings from '@/components/VeoStaffWarnings';

const field = 'border border-slate-300 rounded px-3 py-2 bg-white text-slate-900 w-full';
const button = 'rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-40';
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const money = (n: number, c: string) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: c }).format(n / 100);
const label = (v: string) => v.replaceAll('_', ' ').replace(/\b\w/g, m => m.toUpperCase());

export default function WorkspacePage() {
    return <Suspense fallback={<p className="p-8">Loading VEO…</p>}><Workspace /></Suspense>;
}
function Workspace() {
    const params = useSearchParams(), router = useRouter(), requestedView = params.get('view') || 'dashboard';
    const view = ['closed', 'done'].includes(requestedView) ? 'deals' : requestedView;
    const dealStatus = requestedView === 'done' || params.get('status') === 'done' ? 'done' : 'closed';
    const [data, setData] = useState<any>(null), [pages, setPages] = useState<any[]>([]), [page, setPage] = useState(params.get('page_id') || '');
    const [day, setDay] = useState(today()), [query, setQuery] = useState(params.get('search') || ''), [contacts, setContacts] = useState<WorkspaceContact[]>([]);
    const [contactOffset, setContactOffset] = useState(0), [contactTotal, setContactTotal] = useState(0), [contactsLoading, setContactsLoading] = useState(true), [picked, setPicked] = useState<WorkspaceContact | null>(null);
    const [contact, setContact] = useState(params.get('contact_id') || ''), [order, setOrder] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
    const [role, setRole] = useState('member'), [parent, setParent] = useState(''), [assigned, setAssigned] = useState<string[]>([]);
    const [offset, setOffset] = useState(0), pendingRequests = useRef(new Map<string, string>());
    const refreshGeneration = useRef(0);
    async function refresh() {
        const generation = ++refreshGeneration.current;
        const filters = new URLSearchParams({ date: day, view: view === 'deals' ? dealStatus : ['profile', 'capacity', 'calendar', 'budget', 'performance', 'rankings', 'receipts', 'warnings'].includes(view) ? 'dashboard' : view, search: query, offset: String(offset), ...(page ? { page_id: page } : {}) });
        const r = await fetch(`/api/workspace?${filters}`);
        const body = await r.json();
        if (!r.ok) throw new Error(body.error);
        if (generation !== refreshGeneration.current) return;
        setData(body);
    }
    useEffect(() => {
        const controller = new AbortController();
        fetch('/api/pages', { signal: controller.signal }).then(async r => {
            const body = await r.json(); if (!r.ok) throw new Error(body.error);
            if (!controller.signal.aborted) setPages(body.pages || []);
        }).catch(e => { if (e.name !== 'AbortError') setMessage(e.message); });
        return () => controller.abort();
    }, []);
    useEffect(() => {
        let current = true;
        const timer = setTimeout(() => { refresh().catch(e => { if (current) setMessage(e.message); }); }, 250);
        return () => { current = false; refreshGeneration.current++; clearTimeout(timer); };
    }, [day, view, dealStatus, page, query, offset]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        const id = params.get('contact_id'); if (!id) return;
        const controller = new AbortController();
        fetch(`/api/workspace?contact_id=${encodeURIComponent(id)}`, { signal: controller.signal }).then(async r => { const b = await r.json(); if (!r.ok) throw new Error(b.error); if (b.contact) setPicked({ ...b.contact, page_name: pages.find(p => p.id === b.contact.page_id)?.name || 'Assigned Page' }); }).catch(e => { if (e.name !== 'AbortError') setMessage(e.message); });
        return () => controller.abort();
    }, [params.get('contact_id')]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        if (!data || ['owner', 'team_leader'].includes(data.scope.role) || view !== 'dashboard') return;
        setContactsLoading(true);
        const controller = new AbortController();
        const timer = setTimeout(async () => {
            try {
                const filters = new URLSearchParams({ search: query, offset: String(contactOffset), ...(page ? { page_id: page } : {}) });
                const r = await fetch(`/api/workspace/contacts?${filters}`, { signal: controller.signal });
                const b = await r.json(); if (!r.ok) throw new Error(b.error);
                setContacts(b.items || []); setContactTotal(b.total || 0); setContactsLoading(false);
            } catch (e: any) { if (e.name !== 'AbortError') { setContacts([]); setContactTotal(0); setContactsLoading(false); setMessage(e.message); } }
        }, 250);
        return () => { clearTimeout(timer); controller.abort(); };
    }, [page, query, contactOffset, view, data?.scope.role]);
    async function submit(body: any) {
        setBusy(true); setMessage('');
        const key = body instanceof FormData ? null : JSON.stringify(body);
        if (key && !pendingRequests.current.has(key)) pendingRequests.current.set(key, crypto.randomUUID());
        try {
            const r = await fetch('/api/workspace', body instanceof FormData ? { method: 'POST', body } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request_id: pendingRequests.current.get(key!), ...body }) });
            const b = await r.json(); if (!r.ok) throw new Error(b.error);
            if (key) pendingRequests.current.delete(key);
            setMessage('Saved.'); await refresh(); return b.saved;
        } catch (e: any) { setMessage(e.message); return null; } finally { setBusy(false); }
    }
    if (!data) return <div className="p-8 text-slate-900"><h1 className="text-2xl font-bold">VEO workspace</h1><p className="mt-4" role="status">{message || 'Loading…'}</p></div>;
    const workers = data.accounts.filter((a: any) => a.active !== false && ['member', 'manager'].includes(a.role));
    const isOwner = data.scope.role === 'owner', executive = ['owner', 'team_leader'].includes(data.scope.role);
    const activeView = !executive && ['calendar', 'budget'].includes(view) ? 'dashboard' : isOwner && !['accounts', 'sync', 'profile', 'capacity', 'performance', 'rankings', 'salary', 'calendar', 'budget', 'receipts', 'warnings'].includes(view) ? 'dashboard' : view;
    const availableContacts = picked && !contacts.some(c => c.id === picked.id) ? [picked, ...contacts] : contacts;
    const chosenContact = availableContacts.find(c => c.id === contact);
    const tomorrowTotal = data.tomorrow.filter((w: any) => w.active === true).reduce((n: number, w: any) => n + w.target, 0);
    const supervisor = data.scope.role !== 'member';
    const formData = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); return Object.fromEntries(new FormData(e.currentTarget)); };
    return <div className="mx-auto max-w-7xl p-4 md:p-8 text-slate-900 space-y-6">
        <header><p className="text-xs uppercase tracking-widest">CJ Lara / VEO / {label(data.scope.role)}</p><h1 className="text-3xl font-bold mt-2">{executive && activeView === 'dashboard' ? 'Teams dashboard' : activeView === 'clients' ? 'Clients' : activeView === 'deals' ? 'Deals' : activeView === 'profile' ? 'My profile' : label(activeView)}</h1><p className="mt-2 text-sm text-slate-600">Launch: {new Date(data.scope.launch_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} PHT. All work dates use Philippine time.</p></header>
        <nav className="flex flex-wrap gap-2">{(executive ? ['dashboard', 'performance', 'rankings', 'salary', 'receipts', 'warnings', 'capacity', 'calendar', 'budget', 'accounts', 'sync', 'profile'] : ['dashboard', 'clients', 'deals', 'salary', 'receipts', 'warnings', 'capacity', ...(supervisor ? ['performance', 'rankings', 'accounts'] : []), 'sync', 'profile']).map(v => <Link className={`rounded border px-3 py-2 text-sm ${activeView === v ? 'bg-slate-900 text-white' : 'bg-white'}`} key={v} href={`/dashboard/workspace?view=${v}`}>{executive && v === 'dashboard' ? 'Teams dashboard' : v === 'capacity' ? 'Capacity & Quotas' : v === 'accounts' ? 'Accounts & Teams' : v === 'profile' ? 'My profile' : label(v)}</Link>)}</nav>
        {!executive && ['dashboard'].includes(activeView) && <div className="grid gap-3 md:grid-cols-3"><label>Page<select className={field} value={page} onChange={e => { setPage(e.target.value); setOffset(0); setContactOffset(0); setContact(''); setPicked(null); setOrder(''); }}><option value="">All assigned pages</option>{pages.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>Client search<input className={field} value={query} maxLength={200} onChange={e => { setQuery(e.target.value); setOffset(0); setContactOffset(0); setOrder(''); }} placeholder={activeView === 'deals' ? 'Search client, seller or order' : 'Search client name, ID or saved details'} /></label><label>Philippine work date<input type="date" className={field} value={day} max={today()} onChange={e => { setDay(e.target.value); setOffset(0); }} /></label></div>}
        {(activeView === 'capacity' || (executive && activeView === 'dashboard')) && <label className="block max-w-xs">Philippine work date<input type="date" className={field} value={day} max={today()} onChange={e => setDay(e.target.value)} /></label>}
        {!executive && activeView === 'deals' && <label className="block max-w-xs font-semibold">Deal type<select className={field} value={dealStatus} onChange={e => { setOffset(0); setOrder(''); router.replace(`/dashboard/workspace?view=deals&status=${e.target.value}`); }}><option value="closed">Closed Deals</option><option value="done">Done Deals</option></select></label>}
        {message && <p role="status" className="rounded border bg-amber-50 p-3">{message}</p>}
        {['receipts', 'salary'].includes(activeView) && <VeoReceiptInbox scope={data.scope} accounts={data.accounts} compact={activeView === 'salary'} initialContactId={params.get('contact_id') || ''} />}
        {['warnings', 'dashboard'].includes(activeView) && <VeoStaffWarnings compact={activeView === 'dashboard'} refreshToken={data} />}
        {activeView === 'calendar' && executive && <VeoWorkCalendar scope={data.scope} pages={pages} />}
        {executive && ['dashboard', 'budget'].includes(activeView) && <VeoPageBudget refreshToken={data} scope={data.scope} compact={activeView === 'dashboard'} submit={submit} />}
        {(['performance', 'rankings', 'salary', 'clients', 'deals'].includes(activeView) || activeView === 'dashboard') && <VeoOperationsPanel key={activeView} scope={data.scope} pages={pages} submit={submit} busy={busy} refreshToken={data} workDate={day} initialSearch={params.get('client_search') || ''} mode={activeView === 'deals' ? dealStatus : activeView} />}
        {(activeView === 'capacity' || (!executive && activeView === 'dashboard')) && <VeoCapacitySummary capacity={data.capacity} personal={data.salary.find((s: any) => s.user_id === data.scope.user_id)} />}
        {executive && activeView === 'dashboard' && <div className="flex gap-4 text-sm"><Link className="underline" href="/dashboard/ad-calendar">Calendar & Analytics</Link><Link className="underline" href="/dashboard/ad-quality">Ads Performance</Link></div>}
        {!executive && activeView === 'dashboard' && <section className="rounded border bg-white p-5"><h2 className="font-bold text-xl">Tomorrow&apos;s plan</h2><p className="my-2">{data.tomorrow.filter((w: any) => w.active === true).length} participating workers from verified Telegram votes.</p><p className="text-sm text-slate-600">Vote in the active-for-tomorrow poll posted by Jaucian in your mapped Telegram group. The workspace reads that poll automatically.</p><Link className="underline text-sm" href="/dashboard/workspace?view=warnings">Open poll participation and warnings</Link></section>}
        {executive && activeView === 'dashboard' && <VeoTeamsDashboard data={data} busy={busy} />}
        {!executive && activeView === 'dashboard' && <VeoWorkspaceContacts items={contacts} total={contactTotal} offset={contactOffset} loading={contactsLoading} onOffset={setContactOffset} onSelect={c => { setPicked(c); setContact(c.id); setOrder(''); }} />}
        {!executive && activeView === 'dashboard' && chosenContact && <div className="rounded border bg-white p-4 flex items-center justify-between gap-3"><p className="text-sm">Selected client: <strong>{chosenContact.name || 'Unknown client'}</strong></p><button disabled={busy} className={button} onClick={() => void submit({ action: 'client_assignment', contact_id: chosenContact.id, user_id: data.scope.user_id })}>Add to My Clients</button></div>}
        {!executive && ['dashboard'].includes(activeView) && <>
            <form className="rounded border bg-white p-5 space-y-3" onSubmit={async e => { const f = formData(e); await submit({ ...f, action: 'order', page_id: chosenContact?.page_id, contact_id: contact }); }}><h2 id="create-order" className="font-bold text-xl scroll-mt-6">Create order</h2><label className="block">Client<select required className={field} value={contact} onChange={e => { setContact(e.target.value); setPicked(availableContacts.find(c => c.id === e.target.value) || null); }}><option value="">Select client</option>{availableContacts.map(c => <option key={c.id} value={c.id}>{c.name || 'Unknown client'} · {label(c.pipeline_stage || 'unknown')}</option>)}</select></label><label className="block">Seller<select name="seller_id" required className={field} defaultValue={data.scope.user_id}>{workers.map((w: any) => <option key={w.id} value={w.id}>{w.name} ({label(w.role)})</option>)}</select></label><label className="block">Order details<input required name="description" maxLength={500} className={field} /></label><div className="grid grid-cols-2 gap-2"><label>Total<input required name="amount" inputMode="decimal" className={field} placeholder="0.00" /></label><label>Currency<input required name="currency" defaultValue="PHP" pattern="[A-Za-z]{3}" className={field} /></label></div><button disabled={busy || !chosenContact} className={button}>Create order</button></form>
            <section className="rounded border bg-white p-5"><h2 className="font-bold">Photo delivery</h2>{data.submissions.map((s: any) => <p className="text-sm border-t py-2" key={s.id}>{data.orders.find((o: any) => o.id === s.order_id)?.description || s.order_id} · {label(s.status)} · attempts {s.attempt_count}{s.last_error && ` · ${s.last_error}`}{s.deleted_at && ' · temporary photo deleted'}</p>)}</section>
        </>}
        {activeView === 'accounts' && supervisor && <section className="space-y-5"><form className="rounded border bg-white p-5 space-y-3" onSubmit={async e => { const f = formData(e); await submit({ ...f, action: 'create_account', role, parent_id: parent, page_ids: assigned }); }}><h2 className="font-bold text-xl">Create account</h2><div className="grid md:grid-cols-2 gap-3"><label>Name<input name="name" required className={field} /></label><label>Email<input name="email" required type="email" className={field} /></label><label>Password<input name="password" required type="password" autoComplete="new-password" className={field} /></label><label>Role<select className={field} value={role} onChange={e => { setRole(e.target.value); setParent(''); }}>{['member', ...(['owner', 'team_leader'].includes(data.scope.role) ? ['manager'] : []), ...(data.scope.role === 'owner' ? ['team_leader'] : [])].map(r => <option key={r} value={r}>{label(r)}</option>)}</select></label><label>Supervisor<select required className={field} value={parent} onChange={e => setParent(e.target.value)}><option value="">Select supervisor</option>{data.accounts.filter((a: any) => a.active !== false && (role === 'member' ? a.role === 'manager' : role === 'manager' ? ['owner', 'team_leader'].includes(a.role) : a.role === 'owner')).map((a: any) => <option key={a.id} value={a.id}>{a.name} ({label(a.role)})</option>)}</select></label></div><fieldset><legend className="font-semibold">Assigned pages (required)</legend>{pages.filter(p => data.accounts.find((a: any) => a.id === parent)?.page_ids?.includes(p.id)).map(p => <label key={p.id} className="flex gap-2 py-1"><input type="checkbox" checked={assigned.includes(p.id)} onChange={e => setAssigned(old => e.target.checked ? [...old, p.id] : old.filter(id => id !== p.id))} />{p.name}</label>)}</fieldset><button className={button} disabled={busy || !assigned.length}>Create account</button></form>
        {data.accounts.filter((a: any) => a.active !== false && a.id !== data.scope.user_id).map((a: any) => <form key={a.id} className="border rounded bg-white p-5" onSubmit={async e => { e.preventDefault(); const f = new FormData(e.currentTarget); await submit({ action: 'assign_pages', user_id: a.id, page_ids: f.getAll('page_ids') }); }}><h3 className="font-bold">{a.name} · {label(a.role)}</h3><p className="text-sm text-slate-500">{a.email}</p><p className="text-sm text-slate-500">Telegram: {a.telegram_username ? '@' + a.telegram_username : a.telegram_profile_completed_at ? 'No username declared' : 'Not provided yet'}</p><div className="flex flex-wrap gap-4 my-3">{pages.map(p => <label key={p.id} className="flex gap-2"><input name="page_ids" value={p.id} type="checkbox" defaultChecked={a.page_ids?.includes(p.id)} />{p.name}</label>)}</div><button className={button} disabled={busy}>Update page assignments</button><p className="text-xs text-slate-500 mt-2">Removing a supervisor’s page also revokes it from their descendants and blocks queued sends.</p></form>)}
        <VeoStaffOffboarding accounts={data.accounts} scope={data.scope} busy={busy} submit={submit} />
        {data.scope.role === 'owner' && <VeoJaucianIntegration submit={submit} busy={busy} />}
        </section>}
        {activeView === 'sync' && <section className="rounded border bg-white p-5"><h2 className="font-bold text-xl">Collection health</h2>{data.sync.map((s: any) => <article className="py-4 border-t" key={s.page_id}><h3 className="font-semibold">{pages.find(p => p.id === s.page_id)?.name || 'Unknown page'}</h3><p>Last recorded event: {s.last_event_at ? new Date(s.last_event_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : 'Unavailable'} · pending {s.pending} · errors {s.errors}</p><p className="text-sm text-slate-500">{s.coverage}</p></article>)}</section>}
        {activeView === 'profile' && <VeoTelegramProfile />}
        {['accounts', 'profile'].includes(activeView) && <form className="rounded border bg-white p-5 space-y-3" onSubmit={async e => { const f = formData(e); await submit({ ...f, action: 'password' }); e.currentTarget?.reset(); }}><h2 className="font-bold">Email sign-in password</h2><label className="block">Account<select name="user_id" className={field}>{data.accounts.filter((a: any) => activeView !== 'profile' || a.id === data.scope.user_id).map((a: any) => <option key={a.id} value={a.id}>{a.name} · {a.email || 'Email unavailable'}</option>)}</select></label><label className="block">New password<input name="password" required type="password" autoComplete="new-password" className={field} /></label><button className={button} disabled={busy}>Set password</button></form>}
        {isOwner && activeView === 'accounts' && <section className="rounded border bg-slate-50 p-5"><h2 className="font-bold">Read-only history archive</h2><p className="text-sm mt-2">Earlier records are preserved and excluded from this workspace’s targets, capacity and salary. Verified retained payments remain part of each contact’s labelled lifetime value.</p><div className="flex flex-wrap gap-3 mt-3">{[['contacts', 'Contacts'], ['campaigns', 'Campaigns'], ['contact_purchases', 'Orders'], ['contact_verified_payments', 'Verified payments'], ['page_activity_history', 'Activity']].map(([table, title]) => <a key={table} href={`/api/workspace/archive?table=${table}`} target="_blank" rel="noreferrer" className="text-sm underline">View archived {title.toLowerCase()}</a>)}</div></section>}
    </div>;
}
