'use client';
import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import type { WorkspaceContact } from '@/components/VeoWorkspaceContacts';
import VeoDeferredSection from '@/components/VeoDeferredSection';
import VeoPageState from '@/components/VeoPageState';
import { createSearchSchedule } from '@/lib/search-schedule';
import { startAdaptivePolling } from '@/lib/adaptive-polling';
const PanelLoading = () => <VeoPageState title="Opening section" />;
const VeoWorkspaceContacts = dynamic(() => import('@/components/VeoWorkspaceContacts'), { loading: PanelLoading });
const VeoTeamsDashboard = dynamic(() => import('@/components/VeoTeamsDashboard'), { loading: PanelLoading });
const VeoCapacitySummary = dynamic(() => import('@/components/VeoCapacitySummary'), { loading: PanelLoading });
const VeoTelegramProfile = dynamic(() => import('@/components/VeoTelegramProfile'), { loading: PanelLoading });
const VeoJaucianIntegration = dynamic(() => import('@/components/VeoJaucianIntegration'), { loading: PanelLoading });
const VeoOperationsPanel = dynamic(() => import('@/components/VeoOperationsPanel'), { loading: PanelLoading });
const VeoWorkCalendar = dynamic(() => import('@/components/VeoWorkCalendar'), { loading: PanelLoading });
const VeoStaffOffboarding = dynamic(() => import('@/components/VeoStaffOffboarding'), { loading: PanelLoading });
const VeoPageBudget = dynamic(() => import('@/components/VeoPageBudget'), { loading: PanelLoading });
const VeoReceiptInbox = dynamic(() => import('@/components/VeoReceiptInbox'), { loading: PanelLoading });
const VeoStaffWarnings = dynamic(() => import('@/components/VeoStaffWarnings'), { loading: PanelLoading });
const VeoContactIdentitySync = dynamic(() => import('@/components/VeoContactIdentitySync'), { loading: PanelLoading });
const VeoAccountAccess = dynamic(() => import('@/components/VeoAccountAccess'), { loading: PanelLoading });
const VeoMemberSupervisors = dynamic(() => import('@/components/VeoMemberSupervisors'), { loading: PanelLoading });
const VeoNewClients = dynamic(() => import('@/components/VeoNewClients'), { loading: PanelLoading });
const VeoTelegramGroups = dynamic(() => import('@/components/VeoTelegramGroups'), { loading: PanelLoading });
const VeoClientDrawer = dynamic(() => import('@/components/VeoClientDrawer'), { loading: PanelLoading });
const VeoStorageHealth = dynamic(() => import('@/components/VeoStorageHealth'), { loading: PanelLoading });

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
    const [loadedArea, setLoadedArea] = useState('');
    const [loadError, setLoadError] = useState(''), [retry, setRetry] = useState(0);
    const [day, setDay] = useState(today()), [query, setQuery] = useState(params.get('search') || ''), [contacts, setContacts] = useState<WorkspaceContact[]>([]);
    const [contactOffset, setContactOffset] = useState(0), [contactTotal, setContactTotal] = useState(0), [contactsLoading, setContactsLoading] = useState(true), [picked, setPicked] = useState<WorkspaceContact | null>(null);
    const [contact, setContact] = useState(params.get('contact_id') || ''), [order, setOrder] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
    const [drawerContact, setDrawerContact] = useState('');
    const [role, setRole] = useState('member'), [parent, setParent] = useState(''), [assigned, setAssigned] = useState<string[]>([]);
    const [offset, setOffset] = useState(0), pendingRequests = useRef(new Map<string, string>());
    const refreshGeneration = useRef(0);
    const contactSearchSchedule = useRef(createSearchSchedule(query));
    async function refresh(signal?: AbortSignal) {
        const generation = ++refreshGeneration.current;
        const filters = new URLSearchParams({ date: day, view: view === 'deals' ? dealStatus : view, search: query, offset: String(offset), ...(page ? { page_id: page } : {}) });
        const lightweight = ['new_clients', 'telegram'].includes(view);
        const contextual = !['dashboard', 'accounts', 'sync'].includes(view);
        const accounts = ['profile', 'receipts', 'salary'].includes(view) ? '&accounts=1' : '';
        const endpoint = lightweight ? '/api/workspace/new-clients?context=1' : contextual ? `/api/workspace/context?view=${encodeURIComponent(view)}&date=${encodeURIComponent(day)}${accounts}` : `/api/workspace?${filters}`;
        const r = await fetch(endpoint, { signal });
        let body = await r.json();
        if (!r.ok) throw new Error(body.error);
        if (contextual && ['calendar', 'budget'].includes(view) && !['owner', 'team_leader'].includes(body.scope?.role)) {
            const fallback = await fetch(`/api/workspace?${filters}`, { signal }), result = await fallback.json();
            if (!fallback.ok) throw new Error(result.error);body = result;
        }
        if (generation !== refreshGeneration.current) return;
        setData(lightweight ? { scope: body.scope, accounts: [], tomorrow: [] } : body);
        setLoadedArea(view);
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
        const controller = new AbortController();
        setLoadError('');
        void refresh(controller.signal).catch(e => { if (!controller.signal.aborted) setLoadError(e.message || 'The workspace could not be loaded.'); });
        return () => { controller.abort(); refreshGeneration.current++; };
        // Area context does not use client search, page or pagination filters.
        // Those controls refresh their own complete lists instead of reloading team finances.
    }, [day, view, dealStatus, retry]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        const id = params.get('contact_id'); if (!id || ['new_clients', 'telegram'].includes(view)) return;
        const controller = new AbortController();
        fetch(`/api/workspace?contact_id=${encodeURIComponent(id)}`, { signal: controller.signal }).then(async r => { const b = await r.json(); if (!r.ok) throw new Error(b.error); if (b.contact) setPicked({ ...b.contact, page_name: pages.find(p => p.id === b.contact.page_id)?.name || 'Assigned Page' }); }).catch(e => { if (e.name !== 'AbortError') setMessage(e.message); });
        return () => controller.abort();
    }, [params.get('contact_id'), view]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        if (!data || ['owner', 'team_leader'].includes(data.scope.role) || view !== 'dashboard') return;
        setContactsLoading(true);
        let stop: (() => void) | undefined;
        const timer = setTimeout(() => {
            stop = startAdaptivePolling(async signal => {
                try {
                    const filters = new URLSearchParams({ search: query, offset: String(contactOffset), ...(page ? { page_id: page } : {}) });
                    const r = await fetch('/api/workspace/contacts?' + filters, { signal, cache: 'no-store' });
                    const b = await r.json();if (!r.ok) throw Error(b.error);
                    if (!signal.aborted) { setContacts(b.items || []);setContactTotal(b.total || 0);setContactsLoading(false); }
                } catch (e:any) { if (!signal.aborted) { setContactsLoading(false);setMessage(e.message); }throw e; }
            }, { intervalMs: 30000, immediate: true });
        }, contactSearchSchedule.current(query));
        return () => { clearTimeout(timer);stop?.(); };
    }, [page, query, contactOffset, view, data?.scope.role]);
    useEffect(() => {
        if (view !== 'sync') return;
        return startAdaptivePolling(async signal => {
            try { await refresh(signal); }catch (e:any) { if (!signal.aborted) setLoadError(e.message);throw e; }
        }, { intervalMs: 30000 });
    }, [view, day]); // eslint-disable-line react-hooks/exhaustive-deps
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
    if (!data || loadedArea !== view) return <VeoPageState title="VEO workspace" error={loadError} onRetry={() => setRetry(value => value + 1)} />;
    const workers = data.accounts.filter((a: any) => a.active !== false && ['member', 'manager'].includes(a.role));
    const isOwner = data.scope.role === 'owner', executive = ['owner', 'team_leader'].includes(data.scope.role);
    const activeView = !executive && ['calendar', 'budget'].includes(view) ? 'dashboard' : isOwner && !['accounts', 'sync', 'profile', 'capacity', 'performance', 'rankings', 'salary', 'calendar', 'budget', 'receipts', 'warnings', 'new_clients', 'telegram'].includes(view) ? 'dashboard' : view;
    const availableContacts = picked && !contacts.some(c => c.id === picked.id) ? [picked, ...contacts] : contacts;
    const chosenContact = availableContacts.find(c => c.id === contact);
    const tomorrowTotal = data.tomorrow.filter((w: any) => w.active === true).reduce((n: number, w: any) => n + w.target, 0);
    const supervisor = data.scope.role !== 'member';
    const navViews = executive ? ['dashboard', 'new_clients', 'telegram', 'performance', 'rankings', 'salary', 'receipts', 'warnings', 'capacity', 'calendar', 'budget', 'accounts', 'sync', 'profile'] : ['dashboard', 'new_clients', 'telegram', 'clients', 'deals', 'salary', 'receipts', 'warnings', 'capacity', ...(supervisor ? ['performance', 'rankings', 'accounts'] : []), 'sync', 'profile'];
    const viewGroups = [
        { name: 'Work', views: navViews.filter(v => ['dashboard', 'new_clients', 'clients'].includes(v)) },
        { name: 'Sales', views: navViews.filter(v => ['deals', 'salary', 'receipts'].includes(v)) },
        { name: 'Team', views: navViews.filter(v => ['telegram', 'warnings', 'capacity', 'accounts'].includes(v)) },
        { name: 'Reports & Planning', views: navViews.filter(v => ['performance', 'rankings', 'calendar', 'budget'].includes(v)) },
        { name: 'More', views: navViews.filter(v => ['sync', 'profile'].includes(v)) }
    ].filter(group => group.views.length);
    const formData = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); return Object.fromEntries(new FormData(e.currentTarget)); };
    return <div className="dashboard-page">
        <header><p className="text-xs uppercase tracking-widest">CJ Lara / VEO / {label(data.scope.role)}</p><h1 className="text-3xl font-bold mt-2">{executive && activeView === 'dashboard' ? 'Teams dashboard' : activeView === 'clients' ? 'Clients' : activeView === 'deals' ? 'Deals' : activeView === 'profile' ? 'My profile' : label(activeView)}</h1><p className="mt-2 text-sm text-slate-600">Launch: {new Date(data.scope.launch_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} PHT. All work dates use Philippine time.</p></header>
        <details key={'area:' + activeView} className="rounded-xl border border-slate-200 bg-white"><summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Switch workspace area</summary><nav aria-label="Workspace areas" className="grid gap-4 border-t border-slate-100 p-4 sm:grid-cols-2 lg:grid-cols-5">{viewGroups.map(group => <div key={group.name}><p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{group.name}</p>{group.views.map(v => <Link prefetch={false} aria-current={activeView === v ? 'page' : undefined} className={`block rounded px-3 py-2 text-sm ${activeView === v ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`} key={v} href={`/dashboard/workspace?view=${v}`}>{executive && v === 'dashboard' ? 'Teams dashboard' : v === 'capacity' ? 'Capacity & Quotas' : v === 'accounts' ? 'Accounts & Teams' : v === 'profile' ? 'My profile' : label(v)}</Link>)}</div>)}</nav></details>
        {!executive && ['dashboard'].includes(activeView) && <div className="grid gap-3 md:grid-cols-3"><label>Page<select className={field} value={page} onChange={e => { setPage(e.target.value); setOffset(0); setContactOffset(0); setContact(''); setPicked(null); setOrder(''); }}><option value="">All assigned pages</option>{pages.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>Client search<input className={field} value={query} maxLength={200} onChange={e => { setQuery(e.target.value); setOffset(0); setContactOffset(0); setOrder(''); }} placeholder={activeView === 'deals' ? 'Search client, seller or order' : 'Search client name, ID or saved details'} /></label><label>Philippine work date<input type="date" className={field} value={day} max={today()} onChange={e => { setDay(e.target.value); setOffset(0); }} /></label></div>}
        {(activeView === 'capacity' || (executive && activeView === 'dashboard')) && <label className="block max-w-xs">Philippine work date<input type="date" className={field} value={day} max={today()} onChange={e => setDay(e.target.value)} /></label>}
        {!executive && activeView === 'deals' && <label className="block max-w-xs font-semibold">Deal type<select className={field} value={dealStatus} onChange={e => { setOffset(0); setOrder(''); router.replace(`/dashboard/workspace?view=deals&status=${e.target.value}`); }}><option value="closed">Closed Deals</option><option value="done">Done Deals</option></select></label>}
        {message && <p role="status" className="rounded border bg-amber-50 p-3">{message}</p>}
        {loadError && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"><p>{loadError} These are the last loaded results.</p><button type="button" className="btn" onClick={() => setRetry(value => value + 1)}>Try again</button></div>}
        {isOwner && ['dashboard', 'sync'].includes(activeView) && <VeoStorageHealth compact={activeView === 'dashboard'} />}
        {activeView === 'new_clients' && <VeoNewClients scope={data.scope} pages={pages} initialContactId={params.get('contact_id') || ''} onOpenClient={setDrawerContact} />}
        {activeView === 'telegram' && <VeoTelegramGroups />}
        {['receipts', 'salary'].includes(activeView) && <VeoReceiptInbox scope={data.scope} accounts={data.accounts} compact={activeView === 'salary'} initialContactId={params.get('contact_id') || ''} initialKind={params.get('receipt_kind') === 'done' ? 'done' : 'closed'} />}
        {['warnings', 'dashboard'].includes(activeView) && <VeoStaffWarnings compact={activeView === 'dashboard'} refreshToken={data} />}
        {activeView === 'calendar' && executive && <VeoWorkCalendar scope={data.scope} pages={pages} />}
        {executive && activeView === 'dashboard' && <VeoDeferredSection title="Page budgets"><VeoPageBudget refreshToken={data} scope={data.scope} compact submit={submit} /></VeoDeferredSection>}
        {executive && activeView === 'budget' && <VeoPageBudget refreshToken={data} scope={data.scope} submit={submit} />}
        {executive && activeView === 'dashboard' && <VeoDeferredSection title="Detailed team results"><VeoOperationsPanel scope={data.scope} pages={pages} submit={submit} busy={busy} refreshToken={data} workDate={day} mode="dashboard" /></VeoDeferredSection>}
        {(['performance', 'rankings', 'salary', 'clients', 'deals'].includes(activeView) || (!executive && activeView === 'dashboard')) && <VeoOperationsPanel key={activeView} scope={data.scope} pages={pages} submit={submit} busy={busy} refreshToken={data} workDate={day} initialSearch={params.get('client_search') || ''} initialWorkerId={params.get('worker_id') || ''} mode={activeView === 'deals' ? dealStatus : activeView} />}
        {(activeView === 'capacity' || (!executive && activeView === 'dashboard')) && <VeoCapacitySummary scope={data.scope} accounts={data.accounts} capacity={data.capacity} personal={data.salary.find((s: any) => s.user_id === data.scope.user_id)} />}
        {executive && activeView === 'dashboard' && <div className="flex gap-4 text-sm"><Link className="underline" href="/dashboard/ad-calendar">Calendar & Analytics</Link><Link className="underline" href="/dashboard/ad-quality">Ads Performance</Link></div>}
        {!executive && activeView === 'dashboard' && <section className="rounded border bg-white p-5"><h2 className="font-bold text-xl">Tomorrow&apos;s plan</h2><p className="my-2">{data.tomorrow.filter((w: any) => w.active === true).length} participating workers from verified Telegram votes.</p><p className="text-sm text-slate-600">Vote in the active-for-tomorrow poll posted by Jaucian in your mapped Telegram group. The workspace reads that poll automatically.</p><Link className="underline text-sm" href="/dashboard/workspace?view=warnings">Open poll participation and warnings</Link></section>}
        {executive && activeView === 'dashboard' && <VeoTeamsDashboard data={data} busy={busy} />}
        {!executive && activeView === 'dashboard' && <VeoWorkspaceContacts items={contacts} total={contactTotal} offset={contactOffset} loading={contactsLoading} onOffset={setContactOffset} onSelect={c => { setPicked(c); setContact(c.id); setOrder(''); setDrawerContact(c.id); }} />}
        {!executive && activeView === 'dashboard' && chosenContact && <p className="rounded border bg-white p-3 text-sm">Selected client: <strong>{chosenContact.name || 'Unknown client'}</strong>. Assignment and receipt actions are in the client drawer.</p>}
        {!executive && ['dashboard'].includes(activeView) && <>
            <section className="rounded border bg-white p-5 space-y-3"><h2 id="create-order" className="font-bold text-xl">{data.scope.reviewed_deals_enabled ? 'Close Deal & Done Deal submissions' : 'Facebook Business Suite orders'}</h2>{data.scope.reviewed_deals_enabled ? <><p className="text-sm">Select the client in Receipts and upload three photos. Close Deal requires Qualified stage, payment receipt and order created. Done Deal requires Converted stage, payment receipt and order marked paid. {data.scope.supervisor_submissions_enabled?'Staff submissions need supervisor approval. A Manager, Team Leader or Owner can switch auto-approval on to submit and send directly, or off for separate review.':'A different authorized supervisor approves the photos before recording and Telegram delivery.'}</p><div className="flex flex-wrap gap-4"><Link className="underline" href={`/dashboard/workspace?view=receipts&receipt_kind=closed${contact ? '&contact_id=' + contact : ''}`}>Submit Close Deal evidence</Link><Link className="underline" href={`/dashboard/workspace?view=receipts&receipt_kind=done${contact ? '&contact_id=' + contact : ''}`}>Complete an existing deal</Link></div></> : <><p className="text-sm">Create the client order in Facebook Business Suite. Open Receipts to fetch the invoice and total price, choose New deal or complete an earlier Closed Deal, and enter the balance paid.</p><Link className="underline" href={`/dashboard/workspace?view=receipts&receipt_kind=done${contact ? '&contact_id=' + contact : ''}`}>Fetch order and record balance paid</Link></>}</section>
            <section className="rounded border bg-white p-5"><h2 className="font-bold">Photo delivery</h2>{data.submissions.map((s: any) => <p className="text-sm border-t py-2" key={s.id}>{data.orders.find((o: any) => o.id === s.order_id)?.description || s.order_id} · {label(s.status)} · attempts {s.attempt_count}{s.last_error && ` · ${s.last_error}`}{s.deleted_at && ' · temporary photo deleted'}</p>)}</section>
        </>}
        {activeView === 'accounts' && supervisor && <section className="space-y-5"><form className="rounded border bg-white p-5 space-y-3" onSubmit={async e => { const f = formData(e); await submit({ ...f, action: 'create_account', role, parent_id: parent, page_ids: assigned }); }}><h2 className="font-bold text-xl">Create account</h2><p className="text-sm text-slate-600">A team only needs a team leader. To add members without a manager, choose the team leader as their supervisor below.</p><div className="grid md:grid-cols-2 gap-3"><label>Name<input name="name" required className={field} /></label><label>Email<input name="email" required type="email" className={field} /></label><label>Password<input name="password" required type="password" autoComplete="new-password" className={field} /></label><label>Role<select className={field} value={role} onChange={e => { setRole(e.target.value); setParent(''); setAssigned([]); }}>{['member', ...(['owner', 'team_leader'].includes(data.scope.role) ? ['manager'] : []), ...(data.scope.role === 'owner' ? ['team_leader'] : [])].map(r => <option key={r} value={r}>{label(r)}</option>)}</select></label><label>Supervisor<select required className={field} value={parent} onChange={e => { setParent(e.target.value); setAssigned([]); }}><option value="">Select supervisor</option>{data.accounts.filter((a: any) => a.active !== false && (role === 'member' ? ['manager', 'team_leader'].includes(a.role) : role === 'manager' ? ['owner', 'team_leader'].includes(a.role) : a.role === 'owner')).map((a: any) => <option key={a.id} value={a.id}>{a.name} ({label(a.role)})</option>)}</select></label></div><fieldset><legend className="font-semibold">{role === 'member' ? 'Initial Pages (optional; verified Telegram membership adds team Pages automatically)' : 'Assigned Pages (required)'}</legend>{pages.filter(p => data.accounts.find((a: any) => a.id === parent)?.page_ids?.includes(p.id)).map(p => <label key={p.id} className="flex gap-2 py-1"><input type="checkbox" checked={assigned.includes(p.id)} onChange={e => setAssigned(old => e.target.checked ? [...old, p.id] : old.filter(id => id !== p.id))} />{p.name}</label>)}</fieldset><button className={button} disabled={busy || (!assigned.length && role !== 'member')}>Create account</button></form>
        {data.accounts.filter((a: any) => a.active !== false && a.id !== data.scope.user_id).map((a: any) => <form key={a.id} className="border rounded bg-white p-5" onSubmit={async e => { e.preventDefault(); const f = new FormData(e.currentTarget); await submit({ action: 'assign_pages', user_id: a.id, page_ids: f.getAll('page_ids') }); }}><h3 className="font-bold">{a.name} · {label(a.role)}</h3>{['manager', 'member'].includes(a.role) && <Link className="inline-block text-sm underline my-2" href={"/dashboard/workspace?view=performance&worker_id=" + encodeURIComponent(a.id)}>View staff performance, earnings and graphs</Link>}<p className="text-sm text-slate-500">{a.email}</p><p className="text-sm text-slate-500">Telegram: {a.telegram_username ? '@' + a.telegram_username : a.telegram_profile_completed_at ? 'No username declared' : 'Not provided yet'}</p><div className="flex flex-wrap gap-4 my-3">{pages.map(p => <label key={p.id} className="flex gap-2"><input name="page_ids" value={p.id} type="checkbox" defaultChecked={a.page_ids?.includes(p.id)} />{p.name}</label>)}</div><button className={button} disabled={busy}>Update page assignments</button><p className="text-xs text-slate-500 mt-2">Removing a supervisor’s page also revokes it from their descendants and blocks queued sends.</p></form>)}
        <VeoStaffOffboarding accounts={data.accounts} scope={data.scope} busy={busy} submit={submit} />
        {data.scope.role === 'owner' && <><Link className="underline" href="/dashboard/workspace?view=telegram">Open Telegram groups, Pages and people</Link><VeoJaucianIntegration submit={submit} busy={busy} editable={false} /></>}
        </section>}
        {activeView === 'accounts' && isOwner && <VeoAccountAccess onSaved={refresh} />}
        {activeView === 'accounts' && <VeoMemberSupervisors accounts={data.accounts} scope={data.scope} busy={busy} submit={submit} />}
        {activeView === 'sync' && isOwner && <VeoContactIdentitySync pages={pages} />}
        {activeView === 'sync' && <section className="rounded border bg-white p-5"><h2 className="font-bold text-xl">Collection health</h2>{data.sync.map((s: any) => <article className="py-4 border-t" key={s.page_id}><h3 className="font-semibold">{pages.find(p => p.id === s.page_id)?.name || 'Unknown page'}</h3><p>Last recorded event: {s.last_event_at ? new Date(s.last_event_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : 'Unavailable'} · pending {s.pending} · errors {s.errors}</p><p className="text-sm">Oldest pending: {s.oldest_pending_at ? new Date(s.oldest_pending_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : 'None'} ? Automatic contact sync: {s.identity_sync_at ? new Date(s.identity_sync_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : 'Waiting for first scan'}</p>{s.identity_sync_error&&<p className="text-sm text-amber-800">{s.identity_sync_error}</p>}<p className="text-sm text-slate-500">{s.coverage}</p></article>)}</section>}
        {activeView === 'profile' && <VeoTelegramProfile />}
        {['accounts', 'profile'].includes(activeView) && <form className="rounded border bg-white p-5 space-y-3" onSubmit={async e => { const f = formData(e); await submit({ ...f, action: 'password' }); e.currentTarget?.reset(); }}><h2 className="font-bold">Email sign-in password</h2><label className="block">Account<select name="user_id" className={field}>{data.accounts.filter((a: any) => activeView !== 'profile' || a.id === data.scope.user_id).map((a: any) => <option key={a.id} value={a.id}>{a.name} · {a.email || 'Email unavailable'}</option>)}</select></label><label className="block">New password<input name="password" required type="password" autoComplete="new-password" className={field} /></label><button className={button} disabled={busy}>Set password</button></form>}
        {isOwner && activeView === 'accounts' && <section className="rounded border bg-slate-50 p-5"><h2 className="font-bold">Read-only history archive</h2><p className="text-sm mt-2">Earlier records are preserved and excluded from this workspace’s targets, capacity and salary. Verified retained payments remain part of each contact’s labelled lifetime value.</p><div className="flex flex-wrap gap-3 mt-3">{[['contacts', 'Contacts'], ['campaigns', 'Campaigns'], ['contact_purchases', 'Orders'], ['contact_verified_payments', 'Verified payments'], ['page_activity_history', 'Activity']].map(([table, title]) => <a key={table} href={`/api/workspace/archive?table=${table}`} target="_blank" rel="noreferrer" className="text-sm underline">View archived {title.toLowerCase()}</a>)}</div></section>}
        {drawerContact && <VeoClientDrawer contactId={drawerContact} onClose={() => setDrawerContact('')} />}
    </div>;
}
