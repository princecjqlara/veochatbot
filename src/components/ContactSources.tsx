'use client';

import { useCallback, useEffect, useState } from 'react';
import AdCreativePreview from '@/components/AdCreativePreview';
import { phtDay } from '@/lib/ad-calendar';

const when = (value?: string | null) => value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded';
const roleLabel = (role: string) => role === 'origin' ? 'Verified origin evidence' : role === 'later_touch' ? 'Later touch' : 'Origin not established';

function AdDetails({ ad, pageId, at }: { ad: any; pageId: string; at?: string | null }) {
    if (!ad) return <p className="text-sm text-slate-500">This referral did not include an ad ID.</p>;
    return <div className="min-w-0 space-y-3">
        <div><p className="break-words text-sm font-semibold">{ad.ad_name || ad.ad_title || `Ad ${ad.ad_id}`}</p>
            {ad.ad_name && ad.ad_title && <p className="mt-1 break-words text-sm text-slate-600">{ad.ad_title}</p>}
            <p className="mt-1 break-all text-xs text-slate-500">Ad ID {ad.ad_id}</p></div>
        <AdCreativePreview ad={ad} />
        <p className="text-xs leading-5 text-slate-500">{ad.creative_basis === 'referral_snapshot'
            ? 'Creative captured with this Facebook referral.' : ad.creative_basis === 'catalog'
                ? 'Latest saved creative preview. The ad may have changed since this referral.' : 'A usable creative preview has not been supplied. The source evidence is retained.'}</p>
        {ad.catalog_preview && <details className="rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer text-sm font-medium">Latest saved creative preview</summary><AdCreativePreview ad={ad.catalog_preview} /><p className="mt-2 text-xs text-slate-500">This catalog preview may differ from the creative captured with the referral.</p></details>}
        <details className="rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer text-sm font-medium">Ad, campaign and ad-set details</summary>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">{[
                ['Campaign', ad.campaign_name], ['Campaign ID', ad.campaign_id], ['Ad set', ad.adset_name], ['Ad-set ID', ad.adset_id],
                ['Creative name', ad.creative_name], ['Creative ID', ad.creative_id], ['Ad account ID', ad.ad_account_id], ['Ad status', ad.ad_status],
                ['Preview / metadata status', ad.metadata_status?.replaceAll('_', ' ')], ['Metadata source', ad.metadata_source?.replaceAll('_', ' ')],
                ['Metadata checked', when(ad.metadata_checked_at)]
            ].map(([label, value]) => <div key={label}><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-1 break-words [overflow-wrap:anywhere]">{value || 'Not available'}</dd></div>)}</dl>
            <p className="mt-3 text-xs text-slate-500">Ads Manager names, IDs and status describe the saved catalog entry. Missing details can require ad-account read access.</p>
        </details>
        <a className="inline-block text-xs text-blue-700 underline" target="_blank" rel="noopener noreferrer" href={`https://www.facebook.com/adsmanager/manage/ads?selected_ad_ids=${encodeURIComponent(ad.ad_id)}`}>Open in Ads Manager</a>
        <a className="block text-xs text-blue-700 underline" href={'/dashboard/ad-calendar?' + new URLSearchParams({ pageId, adId: ad.ad_id,
            ...(at && Number.isFinite(Date.parse(at)) ? { month: phtDay(Date.parse(at)).slice(0, 7), day: phtDay(Date.parse(at)) } : {}) })}>Spend and results for this referral day</a>
    </div>;
}

function ReferralEvidence({ touch, onMessage }: { touch: any; onMessage: (id: string) => void }) {
    return <div className="space-y-3 text-sm">
        <dl className="grid gap-3 sm:grid-cols-2">{[
            ['Facebook event time (PHT)', when(touch.at)], ['Recorded by VeoBot (PHT)', when(touch.received_at)],
            ['Event kind', touch.event_kind], ['Facebook source', touch.source], ['Referral type', touch.referral_type], ['Referral / tracking code', touch.referral_code],
            ['Title captured at referral', touch.ad?.recorded_ad_title], ['Post ID captured at referral', touch.ad?.recorded_post_id]
        ].map(([label, value]) => <div key={label}><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-1 break-words [overflow-wrap:anywhere]">{value || 'Not supplied'}</dd></div>)}</dl>
        {touch.message_id && <button className="text-xs text-blue-700 underline" onClick={() => onMessage(touch.message_id)}>View source conversation message</button>}
        <details><summary className="cursor-pointer text-xs text-slate-500">Source record reference</summary><p className="mt-2 break-all font-mono text-xs text-slate-500">{touch.event_key}</p></details>
    </div>;
}

export default function ContactSources({ pageId, contactId, eventKey = '', onClearFocus, onMessage }: {
    pageId: string; contactId: string; eventKey?: string; onClearFocus: () => void; onMessage: (id: string) => void;
}) {
    const [data, setData] = useState<any>(null), [page, setPage] = useState(1), [loading, setLoading] = useState(false);
    const [error, setError] = useState(''), [notice, setNotice] = useState(''), [refreshing, setRefreshing] = useState(false);
    const base = `/api/pages/${pageId}/contacts/${contactId}/profile/sources`;
    const load = useCallback(async (signal?: AbortSignal) => {
        const params = new URLSearchParams({ page: String(eventKey ? 1 : page), ...(eventKey ? { eventKey } : {}) });
        const response = await fetch(base + '?' + params, { cache: 'no-store', signal });
        const body = await response.json(); if (!response.ok) throw Error(body.error || 'Could not read ad sources');
        return body;
    }, [base, eventKey, page]);
    useEffect(() => {
        const controller = new AbortController(); setLoading(true); setError(''); setData(null);
        void load(controller.signal).then(body => { if (!controller.signal.aborted) setData(body); })
            .catch(e => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [load]);
    async function refreshPreviews() {
        setRefreshing(true); setError(''); setNotice('');
        try {
            const ids = [...new Set<string>([data.origin?.ad?.ad_id, ...data.touches.map((touch: any) => touch.ad?.ad_id)].filter(Boolean))];
            let resolved = 0, attempted = 0;
            for (let offset = 0; offset < ids.length; offset += 20) {
                const response = await fetch('/api/ad-quality/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId, adIds: ids.slice(offset, offset + 20) }) });
                const body = await response.json(); if (!response.ok) throw Error(body.error || 'Could not refresh creative previews');
                resolved += (body.results || []).filter((result: any) => result.resolved).length; attempted += body.results?.length || 0;
            }
            setData(await load()); setNotice(`${resolved} of ${attempted} recorded ads refreshed. Original referral snapshots and attribution stay unchanged. Ads Manager details may require ad-account read access.`);
        } catch (e) { setError((e as Error).message); } finally { setRefreshing(false); }
    }
    if (!data) return <p role={error ? 'alert' : 'status'} className="text-sm text-slate-600">{error || 'Loading recorded sources…'}</p>;
    const hasAds = data.origin?.ad || data.touches.some((touch: any) => touch.ad);
    return <div className="min-w-0 space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Ads and referral sources</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">{data.coverage}</p></div>
            <button disabled={!hasAds || refreshing || loading} onClick={() => void refreshPreviews()} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-40">{refreshing ? 'Refreshing ad previews…' : 'Refresh ad previews'}</button></div>
        {error && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{error}</p>}
        {notice && <p role="status" className="rounded-lg bg-blue-50 p-3 text-sm text-blue-900">{notice}</p>}
        <section className="rounded-xl border border-slate-200 bg-white p-5"><h3 className="mb-4 font-semibold">Originating ad</h3>
            {data.origin ? <div className="grid min-w-0 gap-6 lg:grid-cols-2"><div><p className="mb-3 inline-block rounded-full bg-green-50 px-2 py-1 text-xs text-green-800">Verified at first inquiry</p><AdDetails ad={data.origin.ad} pageId={pageId} at={data.origin.evidence?.at || data.first_inquiry_at} /></div>
                <div><h4 className="mb-3 text-sm font-medium">Attribution evidence</h4>{data.origin.evidence ? <ReferralEvidence touch={data.origin.evidence} onMessage={onMessage} /> : <p className="text-sm text-slate-500">The verified origin record remains saved, but its original referral event is unavailable.</p>}
                    <p className="mt-4 text-xs text-slate-500">Recorded inquiry: {when(data.first_inquiry_at)} · Basis: {data.inquiry_basis.replaceAll('_', ' ')}</p></div></div>
                : <p className="text-sm text-slate-600">{data.attribution_status === 'conflicting_sources' ? 'Facebook source evidence conflicts. No single originating ad can be verified.' : 'The originating ad is not verified. A later ad click or a missing referral does not establish the original source.'}</p>}
        </section>
        <section className="rounded-xl border border-slate-200 bg-white p-5"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">{eventKey ? 'Selected source event' : `Recorded ad and referral touches (${data.total})`}</h3>
            {eventKey && <button className="text-sm text-blue-700 underline" onClick={() => { setPage(1); onClearFocus(); }}>Show all source events</button>}</div>
            <p className="mb-4 text-xs text-slate-500">Newest first. Each event retains its own source and creative evidence.</p>
            <div className="space-y-3">{data.touches.map((touch: any, index: number) => <details key={touch.event_key} open={Boolean(eventKey) || index === 0} className="rounded-lg border border-slate-200 p-4">
                <summary className="cursor-pointer break-words text-sm font-medium">{when(touch.at)} · {touch.ad?.ad_name || touch.ad?.ad_title || (touch.ad ? `Ad ${touch.ad.ad_id}` : touch.source || 'Referral event')} <span className="ml-2 inline-block rounded bg-slate-100 px-2 py-1 text-xs font-normal">{roleLabel(touch.role)}</span></summary>
                <div className="mt-5 grid min-w-0 gap-6 lg:grid-cols-2"><AdDetails ad={touch.ad} pageId={pageId} at={touch.at} /><ReferralEvidence touch={touch} onMessage={onMessage} /></div>
            </details>)}{!data.touches.length && <p className="text-sm text-slate-500">{eventKey ? 'This source event is unavailable.' : 'No recorded referrals for this contact. The source remains unknown.'}</p>}</div>
            {!eventKey && data.total > data.page_size && <div className="mt-5 flex items-center justify-between gap-3"><button disabled={page === 1 || loading} onClick={() => setPage(value => value - 1)} className="rounded border px-3 py-2 text-sm disabled:opacity-40">Previous sources</button><span className="text-xs text-slate-500">Page {data.page} of {Math.ceil(data.total / data.page_size)}</span><button disabled={data.page * data.page_size >= data.total || loading} onClick={() => setPage(value => value + 1)} className="rounded border px-3 py-2 text-sm disabled:opacity-40">Next sources</button></div>}
        </section>
    </div>;
}
