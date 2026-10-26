'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { signIn } from 'next-auth/react';
import { BarChart3, RefreshCw, X } from 'lucide-react';
import { FACEBOOK_PERMISSION_SCOPE } from '@/lib/facebook-permissions';

type AdRow = { ad_id: string | null; ad_name: string | null; ad_title: string | null; campaign_name: string | null; inquiries: number; qualified: number; not_qualified: number; pending: number; opted_out: number; crm_converted: number; order_created: number; not_qualified_rate: number | null; not_qualified_assessed_rate: number | null; photo_url: string | null; post_id: string | null; creative_id: string | null; legacy_dates: number };
type ReportPage = { page: { id: string; name: string; fb_page_id: string }; inquiries: number; attributed: number; not_qualified: number; qualified: number; pending: number; legacy_dates: number; without_inquiry_timestamp: number; tracking_started_at: string; rows: AdRow[] };
type Report = { pages: ReportPage[]; generated_at: string; range: { from: string | null; to: string } };
type Contact = { id: string; name: string | null; psid: string; first_inquiry_at: string; pipeline_stage: string; pipeline_stage_source: string; pipeline_stage_updated_at: string; inquiry_basis: string; first_message_id: string | null; origin_evidence_key: string | null };
const n = (v: number) => Number(v).toLocaleString(), pct = (v: number | null) => v == null ? 'N/A' : `${(Number(v) * 100).toFixed(2)}%`;
const when = (v: string) => new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v));
const initialDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export default function AdQualityPage() {
    const [pages, setPages] = useState<Array<{ id: string; name: string }>>([]), [pageId, setPageId] = useState('all');
    const [range, setRange] = useState('today'), [from, setFrom] = useState(initialDate), [to, setTo] = useState(initialDate);
    const [report, setReport] = useState<Report | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [automatic, setAutomatic] = useState(true), [notice, setNotice] = useState(''), [search, setSearch] = useState(''), [sort, setSort] = useState('count');
    const [detail, setDetail] = useState<{ page: ReportPage['page']; ad: AdRow; filter: string } | null>(null), [contacts, setContacts] = useState<Contact[]>([]), [contactTotal, setContactTotal] = useState(0), [offset, setOffset] = useState(0), [detailError, setDetailError] = useState(''), [detailLoading, setDetailLoading] = useState(false);
    const generation = useRef(0), detailGeneration = useRef(0), inFlight = useRef(false);
    const params = useCallback(() => { const q = new URLSearchParams({ range }); if (pageId !== 'all') q.set('pageId', pageId); if (range === 'custom') { q.set('from', from); q.set('to', to); } return q; }, [pageId, range, from, to]);
    const load = useCallback(async (force = false) => {
        if (inFlight.current && !force) return;
        const issue = ++generation.current; inFlight.current = true; setLoading(true);
        try { const res = await fetch('/api/ad-quality?' + params(), { cache: 'no-store' }), data = await res.json(); if (!res.ok) throw Error(data.error || 'Could not load ad quality'); if (issue !== generation.current) return; setReport(data); setPages(previous => [...new Map([...previous, ...data.pages.map((p: ReportPage) => p.page)].map(p => [p.id, p])).values()].sort((a, b) => a.name.localeCompare(b.name))); setError(''); }
        catch (e) { if (issue === generation.current) setError((e as Error).message); }
        finally { if (issue === generation.current) { inFlight.current = false; setLoading(false); } }
    }, [params]);
    useEffect(() => { setReport(null); setDetail(null); void load(true); }, [load]);
    useEffect(() => {
        if (!automatic) return;
        const tick = () => { if (!document.hidden) void load(); }, timer = setInterval(tick, 15_000);
        window.addEventListener('focus', tick); return () => { clearInterval(timer); window.removeEventListener('focus', tick); };
    }, [automatic, load]);
    const loadContacts = useCallback(async () => {
        if (!detail) return;
        const issue = ++detailGeneration.current; setDetailLoading(true); setDetailError(''); setContacts([]);
        const q = params(); q.set('pageId', detail.page.id); q.set('offset', String(offset));
        if (detail.ad.ad_id) q.set('adId', detail.ad.ad_id); else q.set('unknown', 'true');
        if (detail.filter !== 'all') q.set('stage', detail.filter);
        try { const response = await fetch('/api/ad-quality/contacts?' + q, { cache: 'no-store' }), data = await response.json(); if (!response.ok) throw Error(data.error || 'Could not load contacts'); if (issue === detailGeneration.current) { setContacts(data.contacts); setContactTotal(data.total); } }
        catch (e) { if (issue === detailGeneration.current) setDetailError((e as Error).message); }
        finally { if (issue === detailGeneration.current) setDetailLoading(false); }
    }, [detail, offset, params]);
    useEffect(() => { void loadContacts(); }, [loadContacts]);
    useEffect(() => { if (!automatic || !detail) return; const timer = setInterval(() => { if (!document.hidden) void loadContacts(); }, 15_000); return () => clearInterval(timer); }, [automatic, detail, loadContacts]);
    const open = (page: ReportPage['page'], ad: AdRow, filter: string) => { setOffset(0); setContacts([]); setContactTotal(0); setDetail({ page, ad, filter }); };
    const close = () => { detailGeneration.current++; setDetail(null); };
    const resolve = async () => {
        setNotice('Loading ad names from your connected Facebook account…');
        let total = 0, resolved = 0;
        try {
            for (const page of report?.pages || []) {
                const ids = page.rows.map(r => r.ad_id).filter((x): x is string => !!x);
                for (let start = 0; start < ids.length; start += 20) {
                    const r = await fetch('/api/ad-quality/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId: page.page.id, adIds: ids.slice(start, start + 20) }) }), data = await r.json();
                    if (!r.ok) throw Error(data.error || 'Ad details unavailable'); total += data.results.length; resolved += data.results.filter((x: { resolved: boolean }) => x.resolved).length;
                }
            }
            setNotice(total ? `${resolved} of ${total} ad names updated. Unresolved ads need account access or may be unavailable.` : 'No source-linked ads are recorded in this selection yet.'); void load(true);
        } catch (e) { setNotice((e as Error).message); }
    };
    const totals = (report?.pages || []).reduce((s, p) => ({ inquiries: s.inquiries + Number(p.inquiries), attributed: s.attributed + Number(p.attributed), nq: s.nq + Number(p.not_qualified), pending: s.pending + Number(p.pending), legacy: s.legacy + Number(p.legacy_dates), missing: s.missing + Number(p.without_inquiry_timestamp) }), { inquiries: 0, attributed: 0, nq: 0, pending: 0, legacy: 0, missing: 0 });
    const rows = (report?.pages || []).flatMap(p => p.rows.map(ad => ({ page: p.page, ad }))).filter(x => [x.page.name, x.ad.ad_name, x.ad.ad_title, x.ad.ad_id, x.ad.campaign_name].join(' ').toLowerCase().includes(search.toLowerCase())).sort((a, b) => (sort === 'rate' ? Number(b.ad.not_qualified_rate) - Number(a.ad.not_qualified_rate) : Number(b.ad.not_qualified) - Number(a.ad.not_qualified)) || Number(b.ad.inquiries) - Number(a.ad.inquiries));
    return <div className="p-4 md:p-8 space-y-5 max-w-full min-w-0">
        <div className="flex items-center gap-3"><BarChart3 className="w-7 h-7" /><div><h1 className="text-2xl font-bold">Ad Lead Quality</h1><p className="text-sm text-gray-600">Which ads bring inquiries that are marked not qualified?</p></div></div>
        <div className="border border-black p-4 flex flex-wrap gap-3 items-end">
            <label className="text-sm">Page<select aria-label="Page" className="block border border-black p-2 max-w-full" value={pageId} onChange={e => setPageId(e.target.value)}><option value="all">All my Pages</option>{pages.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="text-sm">First inquiry date · Philippine Time<select aria-label="Date range" className="block border border-black p-2" value={range} onChange={e => setRange(e.target.value)}>{[['today', 'Today'], ['7', 'Last 7 calendar days'], ['30', 'Last 30 calendar days'], ['all', 'All time'], ['custom', 'Custom dates']].map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></label>
            {range === 'custom' && <><label className="text-sm">From<input aria-label="From date" type="date" className="block border border-black p-2" value={from} max={to} onChange={e => setFrom(e.target.value)} /></label><label className="text-sm">Through<input aria-label="Through date" type="date" className="block border border-black p-2" value={to} max={initialDate()} onChange={e => setTo(e.target.value)} /></label></>}
            <button className="border border-black p-2 flex gap-2 items-center" onClick={() => void load(true)} disabled={loading}><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />Refresh</button>
            <label className="text-sm flex gap-2 items-center py-2"><input type="checkbox" checked={automatic} onChange={e => setAutomatic(e.target.checked)} />Update every 15 seconds</label>
        </div>
        <p className="text-sm text-gray-600">Dates select when a lead first inquired. Qualification shows their current recorded pipeline stage, including changes made later. Today is partial; 7 and 30 days include today.</p>
        {error && <div role="alert" className="border border-red-600 bg-red-50 p-3 text-red-800">{error}{report && ' Last successful results remain below; they are not current.'}</div>}
        {!report ? <p>{loading ? 'Loading recorded lead quality…' : 'Report unavailable.'}</p> : <>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">{[['Inquiries in date range', totals.inquiries], ['Recorded not qualified', totals.nq], ['Awaiting / ongoing assessment', totals.pending], ['Source-linked inquiries', totals.attributed]].map(([label, value]) => <div key={String(label)} className="border border-black p-4"><p className="text-sm text-gray-600">{label}</p><p className="text-3xl font-bold mt-2">{n(Number(value))}</p></div>)}</div>
            <div className="border border-black bg-amber-50 p-3 text-sm">{n(totals.inquiries - totals.attributed)} inquiries have no verified originating ad. Unknown does not mean organic. Historical ad sources are not reconstructed from message wording or the date. {n(totals.legacy)} inquiry dates use the older CRM first-interaction timestamp; {n(totals.missing)} Page contacts have no inquiry timestamp and are excluded from dated cohorts.</div>
            <div className="flex flex-wrap gap-3 items-end"><label className="text-sm">Find an ad<input aria-label="Find an ad" className="block border border-black p-2" value={search} onChange={e => setSearch(e.target.value)} placeholder="Ad name, ID, Page or campaign" /></label><label className="text-sm">Sort<select aria-label="Sort ads" className="block border border-black p-2" value={sort} onChange={e => setSort(e.target.value)}><option value="count">Most not-qualified leads</option><option value="rate">Highest not-qualified rate</option></select></label><button className="border border-black px-3 py-2 text-sm" onClick={resolve}>Load ad names / details</button><button className="border border-black px-3 py-2 text-sm" onClick={() => signIn('facebook', { callbackUrl: '/dashboard/ad-quality' }, { scope: FACEBOOK_PERMISSION_SCOPE + ',ads_read', auth_type: 'rerequest' })}>Connect Facebook ad details</button></div>
            {notice && <p role="status" className="text-sm">{notice}</p>}
            <div className="border border-black overflow-x-auto"><table className="w-full text-sm"><thead className="bg-gray-100 text-left"><tr>{['Page / originating ad', 'Inquiries', 'Not qualified', 'NQ / all leads', 'Qualified', 'Pending', 'Order created', 'CRM converted', 'Opted out', 'Contacts'].map(h => <th className="p-3 border-b border-black whitespace-nowrap" key={h}>{h}</th>)}</tr></thead><tbody>{rows.map(({ page, ad }) => <tr key={page.id + ':' + ad.ad_id} className="border-b border-gray-300 align-top"><td className="p-3 min-w-[220px]"><p className="font-semibold">{ad.ad_name || ad.ad_title || (ad.ad_id ? `Ad ${ad.ad_id}` : 'Unknown originating ad')}</p><p className="text-xs text-gray-600">{page.name}{ad.ad_id && ` · ID ${ad.ad_id}`}</p>{ad.campaign_name && <p className="text-xs">{ad.campaign_name}</p>}{ad.ad_id && <a className="underline text-xs" target="_blank" rel="noopener noreferrer" href={`https://www.facebook.com/adsmanager/manage/ads?selected_ad_ids=${encodeURIComponent(ad.ad_id)}`}>Open ad in Ads Manager</a>}</td><td className="p-3">{n(ad.inquiries)}</td><td className="p-3 font-bold text-red-800"><button className="underline" onClick={() => open(page, ad, 'not_qualified')}>{n(ad.not_qualified)}</button></td><td className="p-3">{pct(ad.not_qualified_rate)}<p className="text-xs text-gray-500">{n(ad.not_qualified)} / {n(ad.inquiries)}</p></td><td className="p-3">{n(ad.qualified)}</td><td className="p-3">{n(ad.pending)}</td><td className="p-3">{n(ad.order_created)}</td><td className="p-3">{n(ad.crm_converted)}</td><td className="p-3">{n(ad.opted_out)}</td><td className="p-3"><button className="underline" onClick={() => open(page, ad, 'all')}>View leads</button></td></tr>)}{!rows.length && <tr><td className="p-5" colSpan={10}>No recorded inquiries match this selection.</td></tr>}</tbody></table></div>
            <p className="text-xs text-gray-600">Last successful refresh: {when(report.generated_at)} PHT. Qualification follows recorded staff, Messenger or chatbot decisions; silence is not a disqualification. CRM converted is a pipeline label, not independently verified payment. Small samples can produce extreme rates. Original ad capture began {report.pages[0]?.tracking_started_at ? when(report.pages[0].tracking_started_at) + ' PHT' : 'when tracking was enabled'}.</p>
        </>}
        {detail && <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3" onClick={close}><div role="dialog" aria-modal="true" aria-label="Ad contacts" className="bg-white border-2 border-black w-full max-w-6xl max-h-[90vh] overflow-auto p-4" onClick={e => e.stopPropagation()}><div className="flex justify-between gap-3"><div><h2 className="text-lg font-bold">{detail.ad.ad_name || detail.ad.ad_title || detail.ad.ad_id || 'Unknown originating ad'}</h2><p className="text-sm">{detail.page.name} · first-inquiry cohort in selected dates</p></div><button aria-label="Close contacts" onClick={close}><X /></button></div>
            <label className="block my-3 text-sm">Current recorded stage<select aria-label="Contact stage" className="border border-black p-2 ml-2" value={detail.filter} onChange={e => { setOffset(0); setDetail({ ...detail, filter: e.target.value }); }}><option value="all">All stages</option>{['new', 'engaged', 'collecting_details', 'qualified', 'not_qualified', 'order_created', 'converted', 'opted_out'].map(s => <option key={s} value={s}>{s.replaceAll('_', ' ')}</option>)}</select></label>
            {detailError && <p role="alert" className="text-red-800">{detailError}</p>}{detailLoading ? <p>Loading contacts…</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{['Contact', 'First inquiry PHT', 'Current stage / source', 'Stage updated PHT', 'Inquiry evidence'].map(h => <th key={h} className="p-2 text-left border-b">{h}</th>)}</tr></thead><tbody>{contacts.map(c => <tr key={c.id} className="border-b"><td className="p-2"><a className="underline" target="_blank" rel="noopener noreferrer" href={`https://business.facebook.com/latest/inbox/all?asset_id=${encodeURIComponent(detail.page.fb_page_id)}&selected_item_id=${encodeURIComponent(c.psid)}`}>{c.name || c.psid}</a><p className="text-xs">{c.psid}</p></td><td className="p-2 whitespace-nowrap">{when(c.first_inquiry_at)}</td><td className="p-2">{c.pipeline_stage.replaceAll('_', ' ')}<p className="text-xs">{c.pipeline_stage_source}</p></td><td className="p-2 whitespace-nowrap">{when(c.pipeline_stage_updated_at)}</td><td className="p-2"><span>{c.inquiry_basis.replaceAll('_', ' ')}</span>{c.first_message_id && <p className="text-xs break-all max-w-xs">{c.first_message_id}</p>}</td></tr>)}{!contacts.length && <tr><td colSpan={5} className="p-3">No contacts match this stage.</td></tr>}</tbody></table></div>}
            <div className="flex flex-wrap gap-4 items-center mt-4 text-sm"><button className="border border-black p-2 disabled:opacity-40" disabled={offset === 0 || detailLoading} onClick={() => setOffset(offset - 25)}>Previous</button><span>{n(contactTotal)} contacts · page {Math.floor(offset / 25) + 1}</span><button className="border border-black p-2 disabled:opacity-40" disabled={offset + 25 >= contactTotal || detailLoading} onClick={() => setOffset(offset + 25)}>Next</button></div>
        </div></div>}
    </div>;
}
