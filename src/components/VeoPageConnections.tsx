'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { AlertCircle, CheckCircle2, ExternalLink, Link2, Plus, RefreshCw, Search } from 'lucide-react';
import VeoPageState from './VeoPageState';
import VeoAutoTagStatus from './VeoAutoTagStatus';

type SavedPage = { id: string; facebookPageId: string; name: string; enabled: boolean; status: 'ready' | 'reconnect_required' | 'setup_needed' | 'unknown' | 'disabled'; updatedAt: string };
type AvailablePage = { id: string; name: string; category?: string | null; tasks?: string[] };
type Directory = { pages: SavedPage[]; authorization: { active: boolean; configured: boolean; expiresAt: string | null }; callbackUrl: string };
const statuses = {
    ready: { label: 'Connected', color: 'border-emerald-200 bg-emerald-50 text-emerald-800' },
    reconnect_required: { label: 'Reconnect required', color: 'border-red-200 bg-red-50 text-red-800' },
    setup_needed: { label: 'Setup incomplete', color: 'border-amber-200 bg-amber-50 text-amber-800' },
    unknown: { label: 'Unable to verify', color: 'border-slate-200 bg-slate-100 text-slate-600' },
    disabled: { label: 'Disabled', color: 'border-slate-200 bg-slate-100 text-slate-600' }
};
const callbackErrors: Record<string, string> = {
    AUTHORIZATION_CANCELLED: 'Facebook authorization was cancelled. Your saved connections are unchanged.',
    INVALID_STATE: 'That authorization expired or was already used. Start Facebook authorization again.',
    OWNER_REQUIRED: 'Sign in as the workspace Owner to authorize Facebook Pages.',
    UNAUTHORIZED: 'Sign in to your workspace, then authorize Facebook again.',
    SETUP_UNAVAILABLE: 'Facebook authorization could not finish. Retry or use the Page access token option.',
    FACEBOOK_AUTHORIZATION_REQUIRED: 'Facebook needs renewed permissions. Authorize again and select your Pages.'
};
async function read(response: Response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || body.error || 'The request could not be completed. Retry shortly.');
    return body;
}

export default function VeoPageConnections() {
    const { data: session, status } = useSession();
    const owner = status === 'authenticated' && session?.user.role === 'owner';
    const [directory, setDirectory] = useState<Directory | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
    const [available, setAvailable] = useState<AvailablePage[]>([]), [discoveryError, setDiscoveryError] = useState(''), [discovering, setDiscovering] = useState(false), [discovered, setDiscovered] = useState(false);
    const [query, setQuery] = useState(''), [availableQuery, setAvailableQuery] = useState(''), [filter, setFilter] = useState('all');
    const [selected, setSelected] = useState<string[]>([]), [notes, setNotes] = useState<Record<string, string>>({}), [busy, setBusy] = useState('');
    const [templateNotes, setTemplateNotes] = useState<Record<string, string>>({}), [syncNotes, setSyncNotes] = useState<Record<string, string>>({});
    const [autoTemplates, setAutoTemplates] = useState(true), [autoSync, setAutoSync] = useState(true);
    const mounted = useRef(true), busyRef = useRef(false), stop = useRef(false), issue = useRef(0), listing = useRef<AbortController>();
    const authorizationReturn = useRef(false);
    const syncCheckpoints = useRef(new Map<string, { cursor: string; added: number }>());
    const saved = directory?.pages || [], selectedPages = saved.filter(page => selected.includes(page.id));
    const authorizedSaved = saved.filter(page => page.enabled && available.some(item => item.id === page.facebookPageId));
    const unfinishedAuthorized = authorizedSaved.filter(page => page.status !== 'ready');
    const reconnectBlocked = !!busy || !!directory?.authorization.active && (!discovered || discovering);
    const visible = saved.filter(page => (filter === 'all' || filter === 'attention' && page.status !== 'ready' || filter === page.status) && `${page.name} ${page.facebookPageId}`.toLowerCase().includes(query.toLowerCase()));
    const refresh = useCallback(async (fresh = false) => {
        const current = ++issue.current; listing.current?.abort(); const controller = new AbortController(); listing.current = controller;
        try {
            const body = await read(await fetch('/api/workspace/pages' + (fresh ? '?refresh=1' : ''), { cache: 'no-store', signal: controller.signal }));
            if (mounted.current && current === issue.current) { setDirectory(body); setError(''); }
        } catch (error: any) { if (!controller.signal.aborted && mounted.current) setError(error.message); }
    }, []);
    const discover = useCallback(async () => {
        setDiscovering(true); setDiscoveryError(''); setDiscovered(false);
        try {
            const body = await read(await fetch('/api/facebook/pages', { cache: 'no-store', signal: AbortSignal.timeout(50000) }));
            if (!Array.isArray(body.pages)) throw new Error('The authorized Page list is unavailable. Reload available Pages to retry.');
            if (mounted.current) { setAvailable(body.pages); setDiscovered(true); }
        } catch (error: any) { if (mounted.current) { setAvailable([]); setDiscoveryError(error.message); } }
        finally { if (mounted.current) setDiscovering(false); }
    }, []);
    useEffect(() => {
        mounted.current = true; stop.current = false; authorizationReturn.current = false; syncCheckpoints.current.clear(); setDirectory(null); setAvailable([]); setDiscovered(false); setSelected([]); setNotes({}); setTemplateNotes({}); setSyncNotes({}); setError('');
        if (owner) {
            const params = new URLSearchParams(window.location.search), callback = params.get('connection_error');
            authorizationReturn.current = params.get('authorized') === '1';
            if (callback) setNotice(callbackErrors[callback] || 'Facebook authorization did not finish. Retry shortly.');
            void refresh();
        }
        return () => { mounted.current = false; stop.current = true; listing.current?.abort(); issue.current++; };
    }, [owner, session?.user.id, refresh]);
    useEffect(() => { if (owner && directory?.authorization.active) void discover(); }, [owner, directory?.authorization.active, discover]);

    const note = (id: string, message: string) => { if (mounted.current) setNotes(previous => ({ ...previous, [id]: message })); };
    const templateNote = (id: string, message: string) => { if (mounted.current) setTemplateNotes(previous => ({ ...previous, [id]: message })); };
    const syncNote = (id: string, message: string) => { if (mounted.current) setSyncNotes(previous => ({ ...previous, [id]: message })); };
    async function run(title: string, operation: () => Promise<void>) {
        if (busyRef.current) return;
        busyRef.current = true; stop.current = false; setBusy(title); setNotice('');
        try { await operation(); } catch (error: any) { if (mounted.current) setNotice(error.message); }
        finally { if (mounted.current) await refresh(true); busyRef.current = false; if (mounted.current) setBusy(''); }
    }
    async function templates(id: string) {
        for (let batch = 0; batch < 100 && mounted.current && !stop.current; batch++) {
            const result = await read(await fetch('/api/facebook/templates/submit-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId: id, limit: 25 }), signal: AbortSignal.timeout(60000) }));
            if (!result.summary) throw new Error('Template status is unavailable. Open Templates to retry.');
            templateNote(id, `Templates: ${result.summary.approved} approved, ${result.summary.pending} pending, ${result.summary.remaining} remaining; ${result.summary.errors || 0} errors.`);
            if (result.summary.errors) throw new Error(`${result.summary.errors} templates need attention. Open Templates to review and retry; the Page connection is retained.`);
            if (!result.summary.hasMore) return;
        }
        throw new Error('Template setup stopped. Open Templates or run Setup templates again to continue; existing templates are retained.');
    }
    async function connect(payload: Record<string, string>, noteId: string, extras = true) {
        note(noteId, 'Verifying Page access and live message updates…');
        const response = await fetch('/api/facebook/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(95000) });
        const body = await response.json();
        if (!response.ok || body.success !== true || body.saved !== true || body.webhookSubscribed !== true || !body.pageId) {
            if (body.saved) await refresh(true);
            throw new Error(body.message || body.error || 'Page connection could not finish. Retry shortly.');
        }
        note(noteId, body.message); note(body.pageId, body.message);
        if (mounted.current) setDirectory(current => current && ({ ...current, pages: current.pages.map(page => page.id === body.pageId ? { ...page, status: 'ready', enabled: true } : page) }));
        if (extras && autoTemplates && mounted.current && !stop.current) {
            try { await templates(body.pageId); }
            catch (error: any) { templateNote(body.pageId, error.message); }
        }
        if (extras && autoSync && mounted.current && !stop.current) await sync([{ id: body.pageId, facebookPageId: body.facebookPageId || payload.facebookPageId || '', name: body.name || 'Connected Page', enabled: true, status: 'ready', updatedAt: new Date().toISOString() }]);
        if (mounted.current) setNotice(body.message);
        return body;
    }
    async function reconnect(pages: SavedPage[], enableDisabled = false, authorizedOnly = false) {
        if (directory?.authorization.active && (!discovered || discovering)) throw new Error('Reload available Pages before reconnecting so VEO can use your renewed permissions.');
        if (authorizedOnly && !directory?.authorization.active) throw new Error('Authorize Facebook Pages to finish these connections.');
        let complete = 0, failed = 0, skipped = 0;
        for (const page of pages) {
            if (!mounted.current || stop.current) break;
            if (!page.enabled && !enableDisabled) { skipped++; continue; }
            try {
                await connect(authorizedOnly || directory?.authorization.active && available.some(item => item.id === page.facebookPageId) ? { facebookPageId: page.facebookPageId, source: 'authorization' } : { pageId: page.id, source: 'stored' }, page.id, !authorizedOnly); complete++;
            } catch (error: any) { note(page.id, error.message); failed++; }
        }
        if (mounted.current) setNotice(`${complete} Pages reconnected; ${failed} need attention.${skipped ? ` ${skipped} disabled Pages left unchanged; use Reconnect & enable for those Pages.` : ''}${stop.current ? ' Stopped. Remaining Pages were not changed.' : ''}`);
    }
    async function sync(pages: SavedPage[]) {
        for (const page of pages) {
            if (!mounted.current || stop.current) break;
            const checkpoint = syncCheckpoints.current.get(page.id);
            let cursor: string | null = checkpoint?.cursor || null, added = checkpoint?.added || 0; const cursors = new Set<string>();
            try {
                do {
                    if (!mounted.current || stop.current) { syncNote(page.id, `${added} contact identities added. Sync stopped; existing contacts are retained.`); return; }
                    const result = await read(await fetch('/api/workspace/contacts/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page_id: page.id, cursor }), signal: AbortSignal.timeout(65000) }));
                    added += Number(result.inserted || 0); syncNote(page.id, `${added} contact identities added.${result.complete ? ' Sync complete.' : ' Reading the next batch…'}`);
                    if (result.complete) { syncCheckpoints.current.delete(page.id); break; }
                    if (!result.next_cursor || cursors.has(result.next_cursor)) throw new Error('Contact collection could not complete. Retry from Collection health. Saved contacts are retained.');
                    cursors.add(result.next_cursor); cursor = result.next_cursor;
                    syncCheckpoints.current.set(page.id, { cursor: cursor!, added });
                } while (true);
            } catch (error: any) { syncNote(page.id, error.message); }
        }
    }
    useEffect(() => {
        if (!owner || !authorizationReturn.current || !directory?.authorization.active || !discovered || discovering || discoveryError || busyRef.current) return;
        // Consume this callback before starting. Reloading the screen must not
        // repeat connection writes; unfinished Pages have an explicit retry.
        authorizationReturn.current = false;
        const params = new URLSearchParams(window.location.search); params.delete('authorized');
        window.history?.replaceState(window.history.state, '', window.location.pathname + (params.size ? '?' + params : '') + (window.location.hash || ''));
        if (!authorizedSaved.length) { setNotice('Facebook authorization complete. Choose a Page below to connect.'); return; }
        void run('Finishing authorized saved Page connections...', () => reconnect(authorizedSaved, false, true));
        // The callback flag permits one run. The listed inputs supply the
        // completed current grant and Page list before that run starts.
    }, [owner, directory, discovered, discovering, discoveryError, available, busy]); // eslint-disable-line react-hooks/exhaustive-deps
    if (status === 'loading') return <VeoPageState title="Pages & connections" />;
    if (!owner) return <section className="dashboard-page"><h1>Pages & connections</h1><p>Only the workspace Owner can add or reconnect Facebook Pages.</p><Link className="btn" href="/dashboard/workspace">Back to workspace</Link></section>;
    if (!directory) return <VeoPageState title="Pages & connections" error={error} onRetry={() => void refresh(true)} />;
    return <div className="dashboard-page">
        <header className="flex flex-wrap items-start justify-between gap-4"><div><p className="mb-2 text-xs font-semibold uppercase tracking-widest text-indigo-600">Owner workspace</p><h1 className="flex items-center gap-3"><Link2 className="h-7 w-7" />Pages & connections</h1><p className="mt-3 max-w-3xl text-sm leading-6 text-slate-500">Connect a Facebook Page, renew its permissions, and manage team access. Reconnecting keeps its contacts, tags, messages, receipts, sales and chatbot configuration.</p></div><button className="btn" disabled={!!busy} onClick={() => void refresh(true)}><RefreshCw className="h-4 w-4" />Check connections</button></header>
        <div className="grid gap-3 sm:grid-cols-3">{[['Saved Pages', saved.length], ['Connected', saved.filter(page => page.status === 'ready').length], ['Need review', saved.filter(page => page.status !== 'ready').length]].map(([label, count]) => <div className="rounded-xl border bg-white p-5" key={label}><p className="text-xs font-medium text-slate-500">{label}</p><p className="mt-2 text-3xl font-semibold">{count}</p></div>)}</div>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error} Last loaded connections remain visible.</p>}
        {notice && <p role="status" className="rounded-lg border border-indigo-100 bg-indigo-50 p-4 text-sm text-indigo-900">{notice}</p>}
        {busy && <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-white p-4 text-sm"><span>{busy}</span><button className="text-sm font-medium underline" onClick={() => { stop.current = true; setNotice('Stopping after the current request. Completed work is retained.'); }}>Stop after current request</button></div>}
        <section id="add-page" className="rounded-xl border bg-white p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="flex items-center gap-2 text-lg font-semibold"><Plus className="h-5 w-5" />Add a Facebook Page</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">Authorize the Facebook account that manages your Pages, then choose which ones to connect. This keeps your VEO email/password sign-in unchanged.</p></div><button disabled={!!busy || !directory.authorization.configured} className="btn btn-primary" onClick={() => void run('Opening Facebook authorization…', async () => { const body = await read(await fetch('/api/facebook/authorize', { method: 'POST' })); window.location.assign(body.authorizationUrl); })}>{directory.authorization.active ? 'Refresh Facebook permissions' : 'Authorize Facebook Pages'}</button></div>
            {!directory.authorization.configured && <p role="alert" className="mt-3 text-sm text-amber-800">Facebook setup is not configured on the server. Ask the workspace administrator to complete app configuration.</p>}
            {directory.authorization.active && <div className="mt-5 space-y-3 border-t pt-5">
                <div className="flex flex-wrap items-center justify-between gap-3"><p className="flex items-center gap-2 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" />Facebook authorization is active</p><button disabled={discovering || !!busy} className="btn" onClick={() => void discover()}>Reload available Pages</button></div>
                <p className="text-sm leading-6 text-slate-600">Returning from Facebook automatically reconnects your enabled saved Pages using the renewed permissions. Choose new Pages below to connect them.</p>
                {discovered && !discovering && unfinishedAuthorized.length > 0 && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4"><p role="status" className="text-sm text-amber-900">{unfinishedAuthorized.length} authorized saved {unfinishedAuthorized.length === 1 ? 'Page still needs' : 'Pages still need'} connection setup.</p><button className="btn btn-primary" disabled={!!busy} onClick={() => void run('Finishing authorized saved Page connections...', () => reconnect(unfinishedAuthorized, false, true))}>Finish saved Page setup</button></div>}
                <p className="text-xs text-slate-500">Authorization expires {new Date(directory.authorization.expiresAt!).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} PHT. Saved Page connections remain after this selection session expires.</p>
                <label className="block text-sm font-medium">Find an available Page<input className="input-wireframe mt-2 max-w-lg" value={availableQuery} onChange={event => setAvailableQuery(event.target.value)} placeholder="Page name or Facebook Page ID" /></label>
                {discovering && <p role="status" className="text-sm text-slate-500">Loading all authorized Facebook Pages…</p>}
                {discoveryError && <p role="alert" className="text-sm text-red-800">{discoveryError}</p>}
                <div className="grid gap-3 md:grid-cols-2">{available.filter(page => `${page.name} ${page.id}`.toLowerCase().includes(availableQuery.toLowerCase())).map(page => <article key={page.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"><div className="min-w-0"><h3 className="font-semibold">{page.name}</h3><p className="mt-1 text-xs text-slate-500">{page.id}{page.category ? ' · ' + page.category : ''}</p><p role="status" className="mt-1 text-xs text-slate-600">{notes[page.id]}</p></div><button disabled={!!busy} className="btn" onClick={() => void run('Connecting ' + page.name, async () => { await connect({ facebookPageId: page.id, source: 'authorization' }, page.id); })}>{saved.some(item => item.facebookPageId === page.id) ? 'Reconnect' : 'Connect Page'}</button></article>)}</div>
                {!discovering && !discoveryError && !available.length && <p className="text-sm text-slate-500">Facebook returned no manageable Pages. Refresh permissions and select the Pages you want to authorize, or use a Page access token below.</p>}
            </div>}
            <details className="mt-5 border-t pt-4"><summary className="cursor-pointer text-sm font-medium">Connect using a Page access token</summary><form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); const form = event.currentTarget, values = new FormData(form); const facebookPageId = String(values.get('facebookPageId') || ''), pageAccessToken = String(values.get('pageAccessToken') || ''); void run('Verifying Page credentials…', async () => { await connect({ facebookPageId, pageAccessToken, source: 'manual' }, facebookPageId); form.reset(); }); }}><label className="text-sm font-medium">Facebook Page ID<input name="facebookPageId" inputMode="numeric" pattern="[0-9]{1,100}" required maxLength={100} className="input-wireframe mt-2" /></label><label className="text-sm font-medium">Page access token<input name="pageAccessToken" type="password" autoComplete="off" required maxLength={8192} className="input-wireframe mt-2" /></label><p className="text-xs leading-5 text-slate-500 sm:col-span-2">Use a Page token for this workspace’s Facebook app. VEO verifies the Page identity, inbox access and app before saving. Your token is never shown in the connection list.</p><button disabled={!!busy || !directory.authorization.configured} className="btn btn-primary sm:justify-self-start">Verify and connect Page</button></form></details>
            <label className="mt-5 flex items-start gap-2 border-t pt-4 text-sm"><input className="mt-1" type="checkbox" checked={autoTemplates} onChange={event => setAutoTemplates(event.target.checked)} disabled={!!busy} /><span>Set up missing utility templates after connecting<span className="mt-1 block text-xs text-slate-500">Existing templates are retained. Facebook approval and any failures are reported separately from the Page connection.</span></span></label>
            <label className="mt-3 flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={autoSync} onChange={event => setAutoSync(event.target.checked)} disabled={!!busy} /><span>Sync contact names and identities after connecting<span className="mt-1 block text-xs text-slate-500">Reads all contact batches and skips existing records. Historical messages, financial records and archived automations are not imported.</span></span></label>
        </section>
        <section className="overflow-hidden rounded-xl border bg-white">
            <div className="flex flex-wrap items-end justify-between gap-4 p-5"><div><h2 className="text-lg font-semibold">Saved Page connections</h2><p className="mt-1 text-xs text-slate-500">All workspace Pages remain listed, including disabled or expired connections.</p></div><div className="flex flex-wrap gap-3"><label className="relative"><span className="sr-only">Find saved Pages</span><Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" /><input aria-label="Find saved Pages" className="input-wireframe pl-9" value={query} onChange={event => setQuery(event.target.value)} placeholder="Page name or ID" /></label><select aria-label="Filter connection status" className="input-wireframe w-auto" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All statuses</option><option value="ready">Connected</option><option value="attention">Needs review</option><option value="disabled">Disabled</option></select></div></div>
            <div className="flex flex-wrap items-center gap-3 border-y bg-slate-50 px-5 py-3 text-sm"><span className="mr-auto text-xs text-slate-500">{selected.length} selected · {visible.length} of {saved.length} Pages shown</span><button disabled={reconnectBlocked || !selectedPages.length} className="btn" onClick={() => void run('Reconnecting selected Pages…', () => reconnect(selectedPages))}>Reconnect selected</button><button disabled={reconnectBlocked || !saved.length} className="btn" onClick={() => void run('Reconnecting all saved Pages…', () => reconnect(saved))}>Reconnect all saved Pages</button><button disabled={!!busy || !selectedPages.length} className="btn" onClick={() => void run('Syncing selected contact identities…', () => sync(selectedPages))}>Sync selected contacts</button><button disabled={!!busy || !saved.some(page => page.status === "ready")} className="btn" onClick={() => void run("Syncing all connected Page contacts...", () => sync(saved.filter(page => page.status === "ready")))}>Sync all connected Pages</button></div>
            <div className="overflow-x-auto"><table className="table-wireframe min-w-[740px]"><thead><tr><th><input aria-label="Select all visible Pages" type="checkbox" checked={visible.length > 0 && visible.every(page => selected.includes(page.id))} onChange={event => setSelected(previous => event.target.checked ? [...new Set([...previous, ...visible.map(page => page.id)])] : previous.filter(id => !visible.some(page => page.id === id)))} /></th><th>Page</th><th>Connection</th><th>Manage</th></tr></thead><tbody>{visible.map(page => <tr key={page.id}><td><input aria-label={'Select ' + page.name} type="checkbox" checked={selected.includes(page.id)} onChange={event => setSelected(previous => event.target.checked ? [...previous, page.id] : previous.filter(id => id !== page.id))} /></td><td><p className="font-semibold">{page.name}</p><p className="mt-1 text-xs text-slate-500">Facebook ID {page.facebookPageId}</p><a href={'https://www.facebook.com/' + page.facebookPageId} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-indigo-700 hover:underline">Open Facebook Page<ExternalLink className="h-3 w-3" /></a>{[notes[page.id], templateNotes[page.id], syncNotes[page.id]].filter(Boolean).map((message, index) => <p key={index} role="status" className="mt-2 max-w-md text-xs leading-5 text-slate-600">{message}</p>)}</td><td><span className={'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ' + statuses[page.status].color}>{page.status !== 'ready' && <AlertCircle className="h-3 w-3" />}{statuses[page.status].label}</span>{page.status === 'setup_needed' && <p className="mt-2 max-w-xs text-xs text-slate-600">{directory.authorization.active ? 'Facebook is authorized. Finish this Page connection to enable live message updates.' : 'Authorize Facebook Pages, then reconnect this Page to enable live message updates.'}</p>}{page.status === 'unknown' && <p className="mt-2 max-w-xs text-xs text-slate-500">Facebook could not confirm current health. Saved access has not been removed.</p>}</td><td><div className="flex flex-wrap gap-2"><button disabled={reconnectBlocked} className="btn" onClick={() => void run('Reconnecting ' + page.name, () => reconnect([page], true))}>{page.status === 'disabled' ? 'Reconnect & enable' : 'Reconnect'}</button><button disabled={!!busy} className="btn" onClick={() => void run('Setting up templates for ' + page.name, () => templates(page.id))}>Setup templates</button><button disabled={!!busy} className="btn" onClick={() => void run('Syncing contacts for ' + page.name, () => sync([page]))}>Sync contacts</button></div><div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-indigo-700"><Link className="hover:underline" href="/dashboard/workspace?view=accounts">Manage team access</Link><Link className="hover:underline" href={'/dashboard/contacts?pageId=' + page.id}>Contacts & bulk tools</Link><Link className="hover:underline" href={'/dashboard/chatbot?pageId=' + page.id}>AI chatbot</Link><Link className="hover:underline" href={'/dashboard/templates?pageId=' + page.id}>Templates</Link><Link className="hover:underline" href="/dashboard/workspace?view=telegram">Telegram routing</Link></div></td></tr>)}</tbody></table></div>
            {!visible.length && <p className="p-8 text-center text-sm text-slate-500">{saved.length ? 'No Pages match these filters. Clear the search or choose All statuses.' : 'No Pages are connected yet. Add your first Facebook Page above.'}</p>}
        </section>
        <section className="rounded-xl border bg-white p-5 text-sm"><h2 className="font-semibold">Contact collection & webhook setup</h2><p className="mt-2 max-w-4xl leading-6 text-slate-500">Sync contacts adds names and identities in resumable batches. Existing contacts stay unchanged; past messages, sales and archived automation are retained under the current workspace rules. New messages continue through the Page webhook.</p><div className="mt-4 flex flex-wrap gap-3"><Link className="btn" href="/dashboard/workspace?view=sync">Open collection health</Link><Link className="btn" href="/dashboard/settings">Webhook settings</Link></div><details className="mt-4"><summary className="cursor-pointer text-xs font-medium text-slate-500">Facebook app callback details</summary><p className="mt-2 text-xs text-slate-500">If Facebook reports a redirect URL mismatch, register this exact OAuth redirect URL in the connected Meta app:</p><code className="mt-2 block break-all rounded-lg bg-slate-50 p-3 text-xs">{directory.callbackUrl}</code></details></section>
        <VeoAutoTagStatus />
    </div>;
}
