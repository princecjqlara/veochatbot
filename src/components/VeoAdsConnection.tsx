'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { startAdaptivePolling } from '@/lib/adaptive-polling';
const date = (offset = 0) => new Date(Date.now() + 8 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
export default function VeoAdsConnection({ onRefreshed }: { onRefreshed?: () => void }) {
    const [state, setState] = useState<any>(null), [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
    const [from, setFrom] = useState(() => date(-14)), [to, setTo] = useState(() => date());
    const mounted = useRef(true), auto = useRef(false), readId = useRef(0);
    const refreshCallback = useRef(onRefreshed); refreshCallback.current = onRefreshed;
    const load = useCallback(async (signal?: AbortSignal) => {
        const id = ++readId.current;
        const response = await fetch('/api/workspace/ads', { cache: 'no-store', signal });
        if ([401, 403].includes(response.status)) { if (mounted.current) setState({ hidden: true }); return; }
        const body = await response.json(); if (!response.ok) throw Error(body.error || 'Advertising connection is unavailable');
        if (!['connect_required', 'reconnect_required', 'connected'].includes(body.status)) throw Error('Advertising connection status is unavailable');
        if (!mounted.current || signal?.aborted || id !== readId.current) return;
        setState(body); return body;
    }, []);
    useEffect(() => { mounted.current = true; void load().catch(e => { if (mounted.current) setError(e.message); }); return () => { mounted.current = false; }; }, [load]);
    useEffect(() => {
        if (!state?.refresh_running) return;
        return startAdaptivePolling(async signal => { const body = await load(signal); if (body && !body.refresh_running && !signal.aborted) { setMessage('Advertising refresh finished. Review the latest fetch status.'); refreshCallback.current?.(); } }, { intervalMs: 5000 });
    }, [state?.refresh_running, load]);
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const code = new URLSearchParams(window.location.search).get('connection_error');
        if (code === 'ADS_ACCESS_REQUIRED') setError('Meta did not grant complete ad-account read access. Connect again and approve access to your advertising accounts.');
        else if (code === 'AUTHORIZATION_CANCELLED') setError('Meta authorization was cancelled. Your existing saved connection is retained.');
        else if (code === 'ADS_AUTHORIZATION_FAILED' || code === 'INVALID_STATE') setError('Meta Ads authorization could not finish. Start Connect Meta Ads again.');
        else if (code === 'ADS_TOKEN_EXCHANGE_FAILED') setError('Meta could not extend advertising access. Retry the saved authorization below.');
        else if (code === 'ADS_TOKEN_EXPIRY_UNAVAILABLE') setError('Meta did not provide a verifiable access expiry. Retry authorization below.');
        else if (code === 'ADS_CREDENTIAL_SAVE_FAILED') setError('Advertising consent returned, but saving access failed. Retry authorization below.');
        else if (code === 'ADS_VERIFICATION_UNAVAILABLE' || code === 'FACEBOOK_UNAVAILABLE') setError('Meta verification is temporarily unavailable. Retry the saved authorization below.');
        else if (code === 'ADS_TOKEN_INVALID' || code === 'FACEBOOK_AUTHORIZATION_REQUIRED') setError('Meta requires renewed permission. Connect Meta Ads again.');
        else if (code) setError('The connection did not finish. Recheck connection or start Connect Meta Ads again.');
    }, []);
    async function action(kind: 'authorize' | 'refresh' | 'recover') {
        if (busy) return; setBusy(true); setError(''); setMessage('');
        try {
            const post = (action: string) => fetch('/api/workspace/ads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, from, to }) });
            let response = await post(kind), body = await response.json(); if (!response.ok) throw Error(body.errors?.join('; ') || body.error || 'Advertising fetch is incomplete; recheck and retry to resume.');
            if (!mounted.current) return;
            if (kind === 'authorize') { const url = new URL(body.authorizationUrl); if (url.protocol !== 'https:' || url.hostname !== 'www.facebook.com') throw Error('Invalid Meta authorization address'); window.location.assign(url.toString()); return; }
            if (kind === 'recover') {
                if (body.connected !== true) throw Error('Advertising authorization is incomplete.');
                auto.current = true;
                if (window.location.href && typeof window.history?.replaceState === 'function') { const url = new URL(window.location.href); url.searchParams.delete('connection_error'); url.searchParams.delete('ads_connected'); window.history.replaceState(null, '', url.toString()); }
                await load(); response = await post('refresh');body = await response.json();if (!response.ok) throw Error(body.errors?.join('; ') || body.error || 'Advertising fetch will retry automatically.');
            }
            setMessage(`Fetched ${body.inventory_ads} verified ad entries across ${body.accounts} ad accounts for ${from} through ${to}. Today remains provisional.`);
            await load(); onRefreshed?.();
        } catch (e: any) { if (mounted.current) { setError(e.message); void load().catch(() => {}); } }
        finally { if (mounted.current) setBusy(false); }
    }
    useEffect(() => {
        if (auto.current || !state?.can_manage) return;
        const params = new URLSearchParams(window.location.search), code = params.get('connection_error');
        if (state.pending_authorization && ['ADS_AUTHORIZATION_FAILED','ADS_TOKEN_EXCHANGE_FAILED','ADS_TOKEN_EXPIRY_UNAVAILABLE','ADS_CREDENTIAL_SAVE_FAILED','ADS_VERIFICATION_UNAVAILABLE','FACEBOOK_UNAVAILABLE'].includes(code || '')) { auto.current = true;void action('recover');return; }
        if (state.status !== 'connected' || params.get('ads_connected') !== '1') return;
        auto.current = true;
        if (window.location.href && typeof window.history?.replaceState === 'function') {
            const url = new URL(window.location.href); url.searchParams.delete('ads_connected'); window.history.replaceState(null, '', url.toString());
        }
        if (!state.refresh_running) void action('refresh');
    }, [state]); // eslint-disable-line react-hooks/exhaustive-deps
    if (state?.hidden) return null;
    return <section className="rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-3" aria-label="Meta Ads connection and fetching">
        <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">Ad-account connection and data fetching</h3><button type="button" disabled={busy} className="text-sm underline disabled:opacity-40" onClick={() => { setError(''); void load().catch(e => setError(e.message)); }}>Recheck connection</button></div>
        {!state && !error && <p className="text-sm">Checking advertising data source…</p>}
        {state && <><p className="text-sm">{state.message}</p><p className="text-xs text-slate-600">Verified Marketing API ads: {state.verified_inventory_ads} · Last complete fetch: {state.last_synced_at ? new Date(state.last_synced_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) + ' PHT' : 'Not completed'}{state.expires_at && ' · Access expires ' + new Date(state.expires_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}</p>
            {state.last_error && <p className="text-sm text-amber-800">Last fetch: {state.last_error}</p>}
            {state.can_manage ? <><button type="button" disabled={busy || !state.configured} className="rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-40" onClick={() => void action('authorize')}>{busy ? 'Working…' : state.status === 'connected' ? 'Reconnect Meta Ads' : 'Connect Meta Ads'}</button>{!state.configured && <p className="text-xs text-amber-800">Facebook app authorization is not configured on this server.</p>}
                {state.pending_authorization && <button type="button" disabled={busy} className="rounded border bg-white px-3 py-2 text-sm disabled:opacity-40" onClick={() => void action('recover')}>Retry saved authorization</button>}
                {state.status === 'connected' && <div className="flex flex-wrap items-end gap-3"><label className="text-sm">Fetch from (PHT)<input aria-label="Ads fetch from date" className="block rounded border bg-white p-2" type="date" value={from} max={to} disabled={busy} onChange={e => setFrom(e.target.value)} /></label><label className="text-sm">Fetch through (PHT)<input aria-label="Ads fetch to date" className="block rounded border bg-white p-2" type="date" value={to} min={from} max={date()} disabled={busy} onChange={e => setTo(e.target.value)} /></label><button type="button" disabled={busy || state.refresh_running} className="rounded border bg-white px-3 py-2 text-sm disabled:opacity-40" onClick={() => void action('refresh')}>{busy ? 'Fetching inventory and spend…' : state.refresh_running ? 'Refresh already running' : 'Fetch creatives, budgets and spend'}</button></div>}
            </> : <p className="text-sm text-amber-800">The workspace Owner manages the ad-account connection and source refresh. Your saved reports remain available.</p>}
        </>}
        <p className="text-xs text-slate-600">The cron-job.org ads job is intended to fetch once every hour, even when this page is closed. It must be enabled in your cron-job.org account. Interrupted imports resume on the next run. Choose up to 93 dates for a custom fetch. Detected campaign/ad-set budgets and VEO planning recommendations are shown separately.</p>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}{message && <p role="status" className="text-sm text-green-800">{message}</p>}
    </section>;
}
