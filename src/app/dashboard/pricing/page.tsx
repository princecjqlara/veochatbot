'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { BarChart3, Pause, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { pricingRate, validatePricingExperiment, type PricingExperimentDraft, type PricingMode } from '@/lib/chatbot-pricing';
import { pricingOptionFreebies, type PricingDurationOption } from '@/lib/chatbot-pricing-catalogs';

type Experiment = PricingExperimentDraft & { id: string; status: 'active' | 'paused' | 'archived'; created_at: string };
type Package = PricingExperimentDraft['packages'][number] & { id: string; tag_id: string | null };
type Metric = {
    package_id: string; assigned: number; exposed: number; qualified: number; orders: number; converted: number;
    not_qualified: number; shown: number; promotional_sends: number;
    last_touch_qualified: number; last_touch_orders: number; last_touch_converted: number;
};
type Report = {
    experiments: Experiment[]; experiment: Experiment | null; packages: Package[]; metrics: Metric[]; delivery_reviews?: number;
    bot: { enabled: boolean; follow_up_enabled: boolean; trial_mode_enabled: boolean } | null;
    promotion_timing?: { hold_hours: number; days: number[]; waiting_response: number };
};
const MODE_NAMES: Record<PricingMode, string> = {
    fair_test: 'Fair test', sequence: 'Package sequence', fair_test_sequence: 'Fair test + promotional follow-ups'
};
const freshDraft = (): PricingExperimentDraft => ({
    name: '', mode: 'fair_test', duration_seconds: null, follow_up_gap_minutes: 120, attribution_days: 7, minimum_sample: 100,
    packages: [{ name: '', price: 0, message: '' }, { name: '', price: 0, message: '' }]
});
const percent = (top: number, bottom: number) => {
    const rate = pricingRate(top, bottom);
    return rate === null ? '—' : rate + '%';
};
const money = (price: number) => 'PHP' + Number(price).toLocaleString('en-US', { maximumFractionDigits: 2 });
const fieldClass = 'w-full border border-gray-400 bg-white px-3 py-2 text-sm disabled:bg-gray-100';

export default function PricingPage() {
    const [pages, setPages] = useState<{ id: string; name: string }[]>([]);
    const [pageId, setPageId] = useState('');
    const [runId, setRunId] = useState('');
    const [durationFilter, setDurationFilter] = useState('');
    const [report, setReport] = useState<Report | null>(null);
    const [draft, setDraft] = useState(freshDraft);
    const [showEditor, setShowEditor] = useState(false);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const requestVersion = useRef(0);
    const selection = useRef({ pageId, runId, durationFilter });
    selection.current = { pageId, runId, durationFilter };

    useEffect(() => {
        const controller = new AbortController();
        fetch('/api/pages', { signal: controller.signal }).then(async response => {
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || 'Could not load Pages');
            setPages(body.pages || []);
            setPageId(body.pages?.[0]?.id || '');
            if (!body.pages?.length) setLoading(false);
        }).catch(error => { if (error.name !== 'AbortError') { setError(error.message); setLoading(false); } });
        return () => controller.abort();
    }, []);

    const load = useCallback(async () => {
        if (!pageId) return;
        const version = ++requestVersion.current;
        setLoading(true);
        setError('');
        try {
            const query = new URLSearchParams();
            if (runId) query.set('experiment', runId);
            if (durationFilter) query.set('duration', durationFilter);
            const response = await fetch(`/api/pages/${pageId}/chatbot/pricing` + (query.size ? '?' + query.toString() : ''), { cache: 'no-store' });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || 'Could not load pricing');
            if (version === requestVersion.current && selection.current.pageId === pageId && selection.current.runId === runId && selection.current.durationFilter === durationFilter) setReport(body);
        } catch (error) {
            if (version === requestVersion.current) setError((error as Error).message);
        } finally { if (version === requestVersion.current) setLoading(false); }
    }, [pageId, runId, durationFilter]);
    useEffect(() => { void load(); }, [load]);

    const start = async () => {
        const targetPageId = pageId;
        try {
            const config = validatePricingExperiment(draft);
            setSaving(true); setError(''); setNotice('');
            const response = await fetch(`/api/pages/${targetPageId}/chatbot/pricing`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config)
            });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || 'Could not start pricing run');
            if (selection.current.pageId !== targetPageId) return;
            setShowEditor(false); setDraft(freshDraft()); setNotice('Pricing run started. New eligible customers will receive one package at a time.');
            setDurationFilter('');
            setRunId(body.experiment_id);
        } catch (error) { if (selection.current.pageId === targetPageId) setError((error as Error).message); }
        finally { setSaving(false); }
    };
    const toggle = async () => {
        const experiment = report?.experiment;
        if (!experiment) return;
        const targetPageId = pageId;
        try {
            setSaving(true); setError(''); setNotice('');
            const response = await fetch(`/api/pages/${pageId}/chatbot/pricing`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ experiment_id: experiment.id, status: experiment.status === 'active' ? 'paused' : 'active' })
            });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || 'Could not change pricing run');
            if (selection.current.pageId === targetPageId) await load();
        } catch (error) { if (selection.current.pageId === targetPageId) setError((error as Error).message); }
        finally { setSaving(false); }
    };
    const changePackage = (index: number, change: Partial<Package>) => setDraft(current => ({ ...current,
        packages: current.packages.map((item, position) => position === index ? { ...item, ...change } : item) }));
    const changeOption = (packageIndex: number, optionIndex: number, change: Partial<PricingDurationOption>) => setDraft(current => ({ ...current,
        packages: current.packages.map((pkg, index) => index !== packageIndex ? pkg : { ...pkg,
            options: pkg.options?.map((option, position) => position === optionIndex ? { ...option, ...change } : option) }) }));
    const loadOwnerCatalogs = async () => {
        const targetPageId = pageId;
        try {
            setSaving(true); setError(''); setNotice('');
            const response = await fetch(`/api/pages/${targetPageId}/chatbot/pricing?presets=owner`, { cache: 'no-store' });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || 'Could not load approved catalogs');
            if (selection.current.pageId !== targetPageId) return;
            setDraft(current => ({ ...current, name: current.name || 'Current + 3 additional catalogs', packages: body.packages }));
            setNotice('Loaded the current bot catalog as control plus the 3 additional owner-approved catalogs. Review and start the run to use them.');
        } catch (error) { if (selection.current.pageId === targetPageId) setError((error as Error).message); }
        finally { setSaving(false); }
    };
    const experiment = report?.experiment;
    const rows = (report?.packages || []).map(pkg => ({ ...pkg, metric: report?.metrics.find(metric => metric.package_id === pkg.id) }));
    const totals = (report?.metrics || []).reduce((sum, row) => ({
        exposed: sum.exposed + row.exposed, qualified: sum.qualified + row.qualified, orders: sum.orders + row.orders, converted: sum.converted + row.converted
    }), { exposed: 0, qualified: 0, orders: 0, converted: 0 });
    const sufficientSample = !!experiment && rows.length > 0 && rows.every(row => (row.metric?.exposed || 0) >= experiment.minimum_sample);
    const catalogDurations = [...new Set((report?.packages || []).flatMap(pkg => pkg.options?.map(option => option.duration_seconds) || []))].sort((a, b) => a - b);
    const priceLabel = (pkg: PricingExperimentDraft['packages'][number]) => pkg.options?.length ? `${pkg.options.length} duration options` : money(pkg.price);

    return <div className="p-4 md:p-8 space-y-6 max-w-[1600px] mx-auto">
        <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
                <h1 className="text-2xl font-bold flex items-center gap-2"><BarChart3 className="w-6 h-6" />Pricing packages</h1>
                <p className="text-sm text-gray-600 mt-2">Test starting offers fairly, follow up with alternatives, and measure real customer outcomes.</p>
            </div>
            <button className="btn btn-primary flex items-center gap-2" disabled={!pageId || saving || loading || !!error} onClick={() => { setShowEditor(value => !value); setNotice(''); }}>
                <Plus className="w-4 h-4" />{showEditor ? 'Close editor' : 'New pricing run'}
            </button>
        </div>
        <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm min-w-[200px]">Facebook Page
                <select aria-label="Facebook Page" className={fieldClass + ' mt-1'} value={pageId} disabled={saving} onChange={event => {
                    requestVersion.current++; setPageId(event.target.value); setRunId(''); setDurationFilter(''); setReport(null); setDraft(freshDraft()); setShowEditor(false); setNotice(''); setError('');
                }}>{!pages.length && <option value="">No connected Pages</option>}{pages.map(page => <option key={page.id} value={page.id}>{page.name}</option>)}</select>
            </label>
            {!!report?.experiments.length && <label className="text-sm min-w-[240px]">Pricing run
                <select aria-label="Pricing run" className={fieldClass + ' mt-1'} value={runId || experiment?.id || ''} disabled={saving || loading} onChange={event => {
                    requestVersion.current++; setRunId(event.target.value); setDurationFilter(''); setReport(current => current ? { ...current, experiment: null, packages: [], metrics: [] } : current); setNotice('');
                }}>{report.experiments.map(run => <option key={run.id} value={run.id}>{run.name} ({run.status})</option>)}</select>
            </label>}
            {!!catalogDurations.length && <label className="text-sm min-w-[180px]">Starting duration
                <select aria-label="Starting duration" className={fieldClass + ' mt-1'} value={durationFilter} disabled={saving || loading} onChange={event => {
                    requestVersion.current++; setDurationFilter(event.target.value); setLoading(true);
                }}><option value="">All durations</option>{catalogDurations.map(duration => <option key={duration} value={duration}>{duration}s</option>)}</select>
            </label>}
            <button aria-label="Refresh pricing results" className="btn btn-secondary flex items-center gap-2" disabled={!pageId || loading || saving} onClick={() => void load()}><RefreshCw className="w-4 h-4" />Refresh</button>
        </div>
        {error && <div role="alert" className="border border-red-400 bg-red-50 p-4 text-sm text-red-800">{error}</div>}
        {notice && <div role="status" className="border border-green-400 bg-green-50 p-4 text-sm text-green-800">{notice}</div>}
        {loading && <p role="status" className="text-sm text-gray-600">Loading pricing packages…</p>}
        {!loading && !pages.length && !error && <p className="text-sm">Connect a Facebook Page to create pricing packages. <Link className="underline" href="/dashboard/connect">Connect Page</Link></p>}
        {showEditor && <section className="border border-black bg-gray-50 p-4 md:p-6 space-y-5">
            <div><h2 className="text-lg font-semibold">Create a pricing run</h2><p className="text-sm text-gray-600 mt-1">Use comparable packages for the same customer need. A catalog groups all duration choices under one assigned offer.</p></div>
            <fieldset disabled={saving} className="space-y-5">
                <button type="button" className="btn btn-secondary" onClick={() => void loadOwnerCatalogs()}>Load current + 3 approved catalogs</button>
                <p className="text-xs text-gray-600">Loads the current approved bot prices as the control and the Premium Ads, Main + Bonus Videos, and More Ways to Promote catalogs. Existing knowledge and live offers are preserved until you start a run.</p>
                <div className="grid md:grid-cols-2 gap-4">
                    <label className="text-sm">Run name<input className={fieldClass + ' mt-1'} maxLength={100} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="October video package test" /></label>
                    <label className="text-sm">Delivery mode<select className={fieldClass + ' mt-1'} value={draft.mode} onChange={event => setDraft({ ...draft, mode: event.target.value as PricingMode })}>
                        {Object.entries(MODE_NAMES).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
                    </select></label>
                </div>
                <p className="text-sm text-gray-700">{draft.mode === 'fair_test' ? 'New eligible customers are balanced across starting packages. Each keeps that offer, and alternative package promotions stay off.'
                    : draft.mode === 'sequence' ? 'Every eligible customer starts with the first package. Later follow-ups offer each remaining package once, in your listed order.'
                    : 'New eligible customers are balanced across starting packages. Later follow-ups rotate through the other packages, one at a time. Results compare the complete sequences by starting package.'}</p>
                <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
                    <label className="text-sm">Video duration in seconds (optional)<input type="number" min={1} max={3600} className={fieldClass + ' mt-1'} value={draft.duration_seconds ?? ''} onChange={event => setDraft({ ...draft, duration_seconds: event.target.value ? Number(event.target.value) : null })} placeholder="Any / general products" /></label>
                    <div className="text-sm">Package timing<p className="mt-1 border border-gray-300 bg-white p-3">One package for the first 24 hours. Alternatives use later-day best contact times.</p></div>
                    <label className="text-sm">Outcome attribution window (days)<input type="number" min={1} max={90} className={fieldClass + ' mt-1'} value={draft.attribution_days} onChange={event => setDraft({ ...draft, attribution_days: Number(event.target.value) })} /></label>
                    <label className="text-sm">Minimum delivered customers per package<input type="number" min={10} max={10000} className={fieldClass + ' mt-1'} value={draft.minimum_sample} onChange={event => setDraft({ ...draft, minimum_sample: Number(event.target.value) })} /></label>
                </div>
                <p className="text-xs text-gray-600">A duration limits this run to that video length. For catalogs, leave blank to cover all their durations. The bot waits for the requested duration, balances starting catalogs within that duration, and keeps the assigned catalog if the customer changes length. Configure reminder opportunities in <Link href="/dashboard/chatbot" className="underline">AI Chatbot</Link>.</p>
                <div className="space-y-3">{draft.packages.map((pkg, index) => <div key={index} className="border border-gray-400 bg-white p-4 space-y-3">
                    <div className="flex justify-between items-center"><h3 className="font-semibold text-sm">Package {index + 1}</h3><button type="button" aria-label={`Remove package ${index + 1}`} disabled={draft.packages.length <= (draft.mode === 'sequence' ? 1 : 2)} onClick={() => setDraft({ ...draft, packages: draft.packages.filter((_, position) => position !== index) })}><Trash2 className="w-4 h-4" /></button></div>
                    <div className="grid sm:grid-cols-2 gap-4">
                        <label className="text-sm">Package name<input className={fieldClass + ' mt-1'} maxLength={80} value={pkg.name} onChange={event => changePackage(index, { name: event.target.value })} /></label>
                        {!pkg.options?.length && <label className="text-sm">Total price (PHP)<input type="number" step="0.01" min="0.01" max={10000000} className={fieldClass + ' mt-1'} value={pkg.price || ''} onChange={event => changePackage(index, { price: Number(event.target.value) })} /></label>}
                    </div>
                    {!!pkg.options?.length && <>
                        <label className="text-sm block">Promotional hook<input className={fieldClass + ' mt-1'} maxLength={160} value={pkg.hook || ''} onChange={event => changePackage(index, { hook: event.target.value })} /></label>
                        <div className="overflow-x-auto"><table className="w-full text-sm text-left whitespace-nowrap"><thead><tr>{['Main video', 'Price (PHP)', 'Free 8s videos', 'Posters', 'Captions', 'Extra bonus video (seconds)'].map(label => <th key={label} scope="col" className="p-2">{label}</th>)}</tr></thead><tbody>{pkg.options.map((option, optionIndex) => <tr key={option.duration_seconds}>
                            <th scope="row" className="p-2">{option.duration_seconds}s</th>
                            {(['price', 'addon_videos', 'posters', 'captions', 'bonus_video_seconds'] as const).map(field => <td key={field} className="p-1"><input aria-label={`${pkg.name} ${option.duration_seconds}s ${field}`} type="number" className={fieldClass + ' min-w-[90px]'} min={field === 'price' ? 0.01 : field === 'bonus_video_seconds' ? 1 : 0} step={field === 'price' ? 0.01 : 1} value={option[field] ?? ''} onChange={event => changeOption(index, optionIndex, { [field]: field === 'bonus_video_seconds' && !event.target.value ? undefined : Number(event.target.value) })} /></td>)}
                        </tr>)}</tbody></table></div>
                    </>}
                    <label className="text-sm block">Offer details and promotional copy{pkg.options?.length ? ' (optional)' : ''}<textarea rows={3} className={fieldClass + ' mt-1'} maxLength={1200} value={pkg.message} onChange={event => changePackage(index, { message: event.target.value })} placeholder={pkg.options?.length ? 'Optional extra terms. Prices, freebies, PHP150 deposit and balance are added from the selected duration.' : 'Describe inclusions, deposit, balance and terms. The total price is added automatically.'} /></label>
                    <p className="text-xs text-gray-500">Use {'{first_name}'} or {'{business}'} for personalization. This exact copy is sent as one package message.</p>
                    {(pkg.name || pkg.message) && <div className="border-l-2 border-cyan-600 bg-cyan-50 p-3 text-sm whitespace-pre-wrap" aria-label={`Package ${index + 1} preview`}><strong>{pkg.name || 'Package name'} · {priceLabel(pkg)}</strong>{pkg.hook && <p>{pkg.hook}</p>}<p>{pkg.message}</p></div>}
                </div>)}</div>
                <button type="button" className="btn btn-secondary" disabled={draft.packages.length >= 10} onClick={() => setDraft({ ...draft, packages: [...draft.packages, { name: '', price: 0, message: '', ...(draft.packages[0].options?.length ? { options: draft.packages[0].options.map(option => ({ duration_seconds: option.duration_seconds, price: 0, addon_videos: 0, posters: 0, captions: 0 })) } : {}) }] })}>+ Add package</button>
                <div className="border-t border-gray-300 pt-4 flex flex-wrap justify-between items-center gap-4">
                    <p className="text-sm text-gray-600 max-w-2xl">Starting a new run archives the current run and keeps its results. Customers already shown a package in an earlier run are excluded. Bot and follow-up enable switches are managed in AI Chatbot.</p>
                    <button className="btn btn-primary" onClick={() => void start()}>{saving ? 'Saving…' : 'Start pricing run'}</button>
                </div>
            </fieldset>
        </section>}
        {!loading && !error && report && !experiment && !showEditor && <div className="border border-gray-400 p-8 text-center space-y-3"><h2 className="text-lg font-semibold">No pricing run yet</h2><p className="text-sm text-gray-600">Add your packages to start comparing qualification, orders and conversion.</p><button className="btn btn-primary" onClick={() => setShowEditor(true)}>Add pricing packages</button></div>}
        {!loading && !error && experiment && <>
            <section className="border border-black p-4 space-y-3">
                <div className="flex flex-wrap justify-between items-center gap-3"><div><h2 className="text-lg font-semibold">{experiment.name} <span className="text-xs border border-gray-400 px-2 py-1 ml-2 uppercase">{experiment.status}</span></h2><p className="text-sm text-gray-600 mt-2">{MODE_NAMES[experiment.mode]} · {experiment.duration_seconds ? `${experiment.duration_seconds}-second videos` : catalogDurations.length ? 'Catalogs across ' + catalogDurations.join(', ') + ' seconds' : 'General packages'} · {experiment.attribution_days}-day outcome window</p></div>
                    {experiment.status !== 'archived' && <button className="btn btn-secondary flex items-center gap-2" disabled={saving} onClick={() => void toggle()}>{experiment.status === 'active' ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}{experiment.status === 'active' ? 'Pause offers' : 'Resume offers'}</button>}
                </div>
                {(!report?.bot?.enabled || (experiment.mode !== 'fair_test' && !report?.bot?.follow_up_enabled)) && <p className="text-sm text-amber-900 bg-amber-50 border border-amber-300 p-3">{!report?.bot?.enabled ? 'The bot is currently off for this Page. ' : ''}{experiment.mode !== 'fair_test' && !report?.bot?.follow_up_enabled ? 'Enable chatbot follow-ups to deliver alternative packages. ' : ''}<Link href="/dashboard/chatbot" className="underline">Open AI Chatbot settings</Link></p>}
                {report?.bot?.trial_mode_enabled && <p className="text-sm text-amber-900">Trial mode is on. Only the selected trial contact can receive these offers.</p>}
                {!!report?.delivery_reviews && <p role="status" className="text-sm text-amber-900 bg-amber-50 border border-amber-300 p-3">{report.delivery_reviews} offer delivery receipt{report.delivery_reviews === 1 ? '' : 's'} pending confirmation. If this remains after refreshing, have an administrator review delivery history before retrying. Uncertain sends are held to prevent duplicate promotions.</p>}
                <p className="text-xs text-gray-600">One package for the first 24 hours. Each remaining package uses the next eligible follow-up on days {(report?.promotion_timing?.days || [2, 3, 5, 7]).join(', ')} at the customer&apos;s best contact hour in Philippine time (12 noon when unknown). Timing follows the last customer message and selected day, with no extra fixed gap. Elapsed opportunities are skipped. Pricing uses days 2, 3, 5, 7 when the ordinary later-day list is empty. Change selected days in <Link href="/dashboard/chatbot" className="underline">AI Chatbot</Link>.</p>
                {experiment.mode !== 'fair_test' && <p className="text-xs text-gray-600">Later-day promotions wait for an eligible Messenger response window. Waiting across this Page: {report?.promotion_timing?.waiting_response || 0}. A marketing-message integration is required to send promotional offers outside that window.</p>}
            </section>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{[
                ['Customers shown a starting offer', totals.exposed], ['Qualified', totals.qualified], ['Orders created', totals.orders], ['Converted', totals.converted]
            ].map(([label, value]) => <div key={label} className="border border-gray-400 p-4"><p className="text-xs text-gray-600">{label}</p><p className="text-3xl font-semibold mt-2 tabular-nums">{value}</p></div>)}</div>
            <section className="space-y-3">
                <h2 className="font-semibold text-lg">Results by starting package</h2>
                <p className="text-sm text-gray-600">Each customer is counted once under their assigned starting package, even after seeing alternatives. Rates use delivered customers; conversion from qualified uses qualified customers. Order Created and Converted are separate observed outcomes. Qualified includes later orders or conversions.</p>
                {!!catalogDurations.length && <p className="text-sm text-gray-600">Use Starting duration to compare the same requested length across catalogs. Outcomes stay in the original duration cohort, including if a customer later changes video length. All durations combines these cohorts.</p>}
                <div className="overflow-x-auto border border-black"><table className="w-full text-sm text-left whitespace-nowrap">
                    <thead className="bg-gray-100"><tr>{['Package', 'Assigned', 'Delivered', 'Qualified', 'Qualification rate', 'Orders created', 'Converted', 'Conversion rate', 'Converted / qualified', 'Not qualified'].map(label => <th className="p-3 border-b border-gray-400" key={label} scope="col">{label}</th>)}</tr></thead>
                    <tbody>{rows.map(row => <tr key={row.id} className="border-b border-gray-200 last:border-0"><th scope="row" className="p-3 font-medium">{row.name}<span className="block text-xs text-gray-500 mt-1">{priceLabel(row)}</span></th>
                        <td className="p-3">{row.metric?.assigned || 0}</td><td className="p-3">{row.metric?.exposed || 0}</td><td className="p-3">{row.metric?.qualified || 0}</td><td className="p-3">{percent(row.metric?.qualified || 0, row.metric?.exposed || 0)}</td><td className="p-3">{row.metric?.orders || 0}</td><td className="p-3">{row.metric?.converted || 0}</td><td className="p-3 font-semibold">{percent(row.metric?.converted || 0, row.metric?.exposed || 0)}</td><td className="p-3">{percent(row.metric?.converted || 0, row.metric?.qualified || 0)}</td><td className="p-3">{row.metric?.not_qualified || 0}</td>
                    </tr>)}</tbody>
                </table></div>
                <div className="grid md:grid-cols-2 gap-3">{rows.map(row => <div key={row.id} className="border border-gray-300 p-4"><div className="flex justify-between gap-3 text-sm"><span>{row.name}</span><span>{row.metric?.exposed || 0} / {experiment.minimum_sample} delivered</span></div><div className="h-2 bg-gray-100 mt-3"><div className="h-2 bg-cyan-700" style={{ width: Math.min(100, (row.metric?.exposed || 0) / experiment.minimum_sample * 100) + '%' }} /></div></div>)}</div>
                <p className="text-xs text-gray-600">{experiment.mode === 'sequence' ? 'Sequence mode is an ordered promotion, so starting-package results are not a randomized comparison.' : sufficientSample ? 'Every package has reached your minimum sample. This threshold is a review aid; it does not establish a statistically reliable winner.' : 'Collecting samples. Avoid choosing a winner from a small number of customers.'} Recent customers may still convert within their attribution window. No package is automatically favored.</p>
            </section>
            <section className="space-y-3">
                <h2 className="font-semibold text-lg">Offers shown and later outcomes</h2><p className="text-sm text-gray-600">These are descriptive last-offer counts. A customer can see several packages; this table does not establish which offer caused a conversion.</p>
                <div className="overflow-x-auto border border-gray-400"><table className="w-full text-sm text-left whitespace-nowrap"><thead className="bg-gray-100"><tr>{['Package', 'Unique customers shown', 'Promotional sends', 'Qualified after last offer', 'Orders after last offer', 'Converted after last offer'].map(label => <th className="p-3 border-b border-gray-300" key={label} scope="col">{label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.id} className="border-b border-gray-200 last:border-0"><th scope="row" className="p-3 font-medium">{row.name}</th><td className="p-3">{row.metric?.shown || 0}</td><td className="p-3">{row.metric?.promotional_sends || 0}</td><td className="p-3">{row.metric?.last_touch_qualified || 0}</td><td className="p-3">{row.metric?.last_touch_orders || 0}</td><td className="p-3">{row.metric?.last_touch_converted || 0}</td></tr>)}</tbody></table></div>
            </section>
            <section className="space-y-3"><h2 className="font-semibold text-lg">Saved packages and tags</h2><div className="grid md:grid-cols-2 gap-4">{rows.map(row => <article key={row.id} className="border border-gray-400 p-4 space-y-2"><h3 className="font-semibold">{row.name} · {priceLabel(row)}</h3>{row.hook && <p className="text-sm font-medium">{row.hook}</p>}<p className="text-sm whitespace-pre-wrap">{row.message}</p>{!!row.options?.length && <div className="space-y-2">{row.options.map(option => <div key={option.duration_seconds} className="text-sm border-t border-gray-200 pt-2"><strong>{option.duration_seconds}s · {money(option.price)}</strong><p className="text-xs text-gray-600">FREE: {pricingOptionFreebies(option)}</p></div>)}</div>}<p className="text-xs text-gray-600">Tag applied after delivery: Price: {experiment.name} / {row.name}</p></article>)}</div><p className="text-xs text-gray-600">Qualified, Not Qualified, Order Created and Converted system tags and pipeline updates record outcomes after the first delivered offer. Repeated signals count once; earlier outcomes are excluded. <Link className="underline" href="/dashboard/tags">Manage tags</Link></p></section>
        </>}
    </div>;
}
