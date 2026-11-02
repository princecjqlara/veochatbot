'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { calendarHeat, phtDay } from '@/lib/ad-calendar';
import AdCreativePreview from '@/components/AdCreativePreview';
import { signIn } from 'next-auth/react';
import { FACEBOOK_PERMISSION_SCOPE } from '@/lib/facebook-permissions';

const number = (value: number | null | undefined) => value == null ? 'N/A' : new Intl.NumberFormat('en-PH', { maximumFractionDigits: 2 }).format(value);
const money = (value: number | null | undefined, currency?: string | null) => value == null || !currency ? 'Not verified' : new Intl.NumberFormat('en-PH', { style: 'currency', currency }).format(value);
const pct = (value: number | null | undefined) => value == null ? 'N/A' : `${(value * 100).toFixed(1)}%`;
const roas = (value: number | null | undefined) => value == null ? 'N/A' : `${value.toFixed(2)}×`;
const dateTime = (value: string | null) => value ? new Date(value).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded';
const fieldStyle = 'max-w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm';
const heatMetrics: Record<string, { label: string; value: (row: any) => number | null; format: string }> = {
 profit: { label: 'Profit after salary and ads', value: row => row.profit, format: 'money' },
 spend: { label: 'Ad spend', value: row => row.spend.amount, format: 'money' },
 inquiries: { label: 'Linked inquiries', value: row => row.inquiries, format: 'count' },
 conversion: { label: 'Stage conversion rate', value: row => row.conversion_rate, format: 'percent' },
 payers: { label: 'Verified paying customers', value: row => row.payers, format: 'count' },
 payer_rate: { label: 'Verified payer rate', value: row => row.payer_rate, format: 'percent' },
 cpa: { label: 'Cost per verified acquisition', value: row => row.cpa, format: 'money' },
 messaging: { label: 'Cost per Meta conversation', value: row => row.cost_per_messaging, format: 'money' },
 gross_roas: { label: 'Gross ROAS', value: row => row.gross_roas, format: 'roas' },
 net_roas: { label: 'Net ROAS (profit / ads)', value: row => row.net_roas, format: 'roas' }
};
function Card({ label, children, note }: { label: string; children: React.ReactNode; note?: string }) {
 return <section className="min-w-0 rounded-xl border border-slate-200 bg-white p-4"><h2 className="text-xs font-medium text-slate-500">{label}</h2><div className="mt-2 break-words text-xl font-semibold">{children}</div>{note && <p className="mt-2 text-xs leading-5 text-slate-500">{note}</p>}</section>;
}
function Revenue({ rows, field = 'gross' }: { rows: any[]; field?: string }) {
 return rows.length ? <>{rows.map(row => <p key={row.currency}>{money(row[field], row.currency)}</p>)}</> : <>Not verified</>;
}

export default function AdCalendar() {
 const today = phtDay(Date.now()), [month, setMonth] = useState(today.slice(0, 7)), [pageId, setPageId] = useState(''), [adId, setAdId] = useState(''), [day, setDay] = useState(today);
 const [data, setData] = useState<any>(null), [loading, setLoading] = useState(false), [error, setError] = useState(''), [metric, setMetric] = useState('profit');
 const [connection, setConnection] = useState<any>(null), [syncing, setSyncing] = useState(false), [notice, setNotice] = useState(''), [remaining, setRemaining] = useState(0), [importError, setImportError] = useState('');
 const [creativeMode, setCreativeMode] = useState('day'), [creativePage, setCreativePage] = useState(1);
 const [showPeople, setShowPeople] = useState(false), [peopleStatus, setPeopleStatus] = useState('all'), [peopleOffset, setPeopleOffset] = useState(0), [people, setPeople] = useState<any>(null);
 const scope = `${month}:${pageId}:${adId}`, scopeRef = useRef(scope); scopeRef.current = scope;
 const tasks = useRef<{ scope: string; items: any[] }>({ scope: '', items: [] });
 useEffect(() => {
  const query = new URLSearchParams(window.location.search), requestedMonth = query.get('month'), requestedDay = query.get('day');
  if (requestedMonth && /^20\d{2}-(0[1-9]|1[0-2])$/.test(requestedMonth) && requestedMonth <= today.slice(0, 7)) { setMonth(requestedMonth); setDay(requestedDay?.startsWith(requestedMonth + '-') ? requestedDay : requestedMonth + '-01'); }
  if (query.get('pageId')) setPageId(query.get('pageId')!); if (query.get('adId')) setAdId(query.get('adId')!);
  void fetch('/api/ad-quality/connection', { cache: 'no-store' }).then(response => response.json()).then(setConnection).catch(() => setConnection({ status: 'temporarily_unavailable', accounts: [], message: 'Ad-account access could not be checked.' }));
 // Initial URL filters are read once; subsequent filters stay local to this report.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, []);
 const queryFor = useCallback(() => new URLSearchParams({ month, day, ...(pageId ? { pageId } : {}), ...(adId ? { adId } : {}) }), [month, day, pageId, adId]);
 const getReport = useCallback(async (signal?: AbortSignal) => {
  const response = await fetch('/api/ad-calendar?' + queryFor(), { cache: 'no-store', signal }), body = await response.json();
  if (!response.ok) throw Error(body.error || 'Calendar unavailable'); return body;
 }, [queryFor]);
 const reloadRef = useRef(getReport); reloadRef.current = getReport;
 const issue = useRef(0);
 const refresh = useCallback(async () => { const current = ++issue.current; setLoading(true); try { const result = await getReport(); if (issue.current === current) { setData(result); setError(''); } } catch (e) { if (issue.current === current) setError((e as Error).message); } finally { if (issue.current === current) setLoading(false); } }, [getReport]);
 useEffect(() => { void refresh(); return () => { issue.current++; }; }, [refresh]);
 useEffect(() => { setData(null); setNotice(''); setImportError(''); setCreativePage(1); setShowPeople(false); setPeopleOffset(0); if (tasks.current.scope !== scope) { tasks.current = { scope, items: [] }; setRemaining(0); } }, [scope]);
 useEffect(() => { const timer = setInterval(() => { if (!document.hidden && !syncing) void refresh(); }, 60000); return () => clearInterval(timer); }, [refresh, syncing]);
 useEffect(() => { setCreativePage(1); setPeopleOffset(0); setPeople(null); }, [day, creativeMode, peopleStatus]);
 useEffect(() => {
  if (!showPeople) return; const controller = new AbortController(); setPeople(null);
  const query = queryFor(); query.set('view', 'contacts'); query.set('status', peopleStatus); query.set('offset', String(peopleOffset));
  void fetch('/api/ad-calendar?' + query, { signal: controller.signal, cache: 'no-store' }).then(async response => { const body = await response.json(); if (!response.ok) throw Error(body.error); if (!controller.signal.aborted) setPeople(body); }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
  return () => controller.abort();
 }, [showPeople, queryFor, peopleStatus, peopleOffset]);
 function changeMonth(value: string) { setMonth(value); setDay(value === today.slice(0, 7) ? today : value + '-01'); }
 async function sync() {
  if (syncing || !connection?.accounts?.length || !data || adId === 'unknown') return;
  const currentScope = scope; setSyncing(true); setImportError('');
  try {
   if (!tasks.current.items.length || tasks.current.scope !== currentScope) {
    let inventoryCalls = 0;
    for (const account of connection.accounts) {
     let after: string | undefined;
     do {
      if (scopeRef.current !== currentScope) return;
      if (inventoryCalls++ >= 100) throw Error('Inventory import reached its batch limit. Select a Page to continue. Saved ads remain available.');
      setNotice('Updating verified ad inventory from Facebook…');
      const response = await fetch('/api/ad-quality/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: account.id, ...(pageId ? { pageId } : {}), ...(after ? { after } : {}) }) }), body = await response.json();
      if (!response.ok) throw Error(body.error || 'Ad inventory unavailable'); if (body.paginationUnavailable) throw Error('Facebook omitted an inventory cursor. Retry before calculating complete spend.');
      after = body.complete ? undefined : body.nextAfter;
     } while (after);
    }
    const latest = await reloadRef.current(); if (scopeRef.current !== currentScope) return; setData(latest);
    const items: any[] = [], until = [latest.range.days.at(-1), today].sort()[0];
    for (const account of connection.accounts) {
     const ids: string[] = [...new Set<string>(latest.inventory.filter((ad: any) => ad.ad_account_id === account.id.replace(/^act_/, '') && (!adId || ad.ad_id === adId)).map((ad: any) => ad.ad_id))];
     for (let offset = 0; offset < ids.length; offset += 20) for (let start = Date.parse((month + '-01') + 'T00:00:00Z'); start <= Date.parse(until + 'T00:00:00Z'); start += 7 * 86400000) {
      items.push({ accountId: account.id, adIds: ids.slice(offset, offset + 20), from: new Date(start).toISOString().slice(0, 10), to: new Date(Math.min(start + 6 * 86400000, Date.parse(until + 'T00:00:00Z'))).toISOString().slice(0, 10), ...(pageId ? { pageId } : {}) });
     }
    }
    tasks.current = { scope: currentScope, items }; setRemaining(items.length);
    if (!items.length) throw Error('No verified ads matched these ad accounts. Check the ad-account connection and Page inventory.');
   }
   let batches = 0;
   while (tasks.current.items.length && batches++ < 75 && scopeRef.current === currentScope) {
    const task = tasks.current.items[0]; setNotice(`Reading ${task.from} through ${task.to} · ${tasks.current.items.length} batches remain. Completed batches are retained.`);
    const response = await fetch('/api/ad-calendar/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(task) }), body = await response.json();
    if (!response.ok) throw Error(body.error || 'Actual spend unavailable'); if (!body.complete) throw Error('The report was not complete. No zero days were assumed.');
    tasks.current.items.shift(); setRemaining(tasks.current.items.length);
   }
   if (scopeRef.current === currentScope) setNotice(tasks.current.items.length ? `${tasks.current.items.length} batches remain. Continue the import to finish coverage.` : 'Actual ad spend and delivery metrics updated. Today remains provisional; Facebook can revise its reports.');
  } catch (e) { if (scopeRef.current === currentScope) setImportError((e as Error).message); }
  finally { setSyncing(false); if (scopeRef.current === currentScope) void refresh(); }
 }
 const summary = data?.summary, selected = data?.days?.find((row: any) => row.day === day), heat = heatMetrics[metric];
 const currencies = new Set<string>((data?.days || []).flatMap((row: any) => row.spend.recorded.map((entry: any) => entry.currency))), mixedMoney = currencies.size > 1;
 const heatValue = (row: any) => mixedMoney && ['money', 'roas'].includes(heat.format) ? null : heat.value(row);
 const scale = Math.max(1, ...(data?.days || []).filter((row: any) => !row.future).map((row: any) => Math.abs(heatValue(row) || 0)));
 const creativeRows = creativeMode === 'day' ? data?.day_ads || [] : data?.ads || [];
 const formatCell = (value: number | null) => {
  if (value == null) return '—';
  const formatted = heat.format === 'percent' ? pct(value) : heat.format === 'roas' ? roas(value) : new Intl.NumberFormat('en-PH', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  return value > 0 && ['profit', 'gross_roas', 'net_roas'].includes(metric) ? '+' + formatted : formatted;
 };
 const blank = data ? (new Date(data.range.days[0] + 'T00:00:00Z').getUTCDay() + 6) % 7 : 0;
 return <div className="min-w-0 space-y-6 p-4 text-slate-800 md:p-8">
  <header><h1 className="text-2xl font-bold">Ad calendar and profit</h1><p className="mt-2 max-w-4xl text-sm leading-6 text-slate-500">Each day groups the leads who first inquired that day. Later conversions and payments keep updating that original cohort. Dates use Philippine Time.</p></header>
  <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 p-4">
   <label className="text-xs font-medium">Inquiry month<input aria-label="Calendar month" type="month" min="2000-01" max={today.slice(0, 7)} disabled={syncing} value={month} onChange={e => changeMonth(e.target.value)} className={`${fieldStyle} mt-1 block`} /></label>
   <label className="text-xs font-medium">Page<select aria-label="Calendar Page" disabled={syncing} value={pageId} onChange={e => { setPageId(e.target.value); setAdId(''); }} className={`${fieldStyle} mt-1 block`}><option value="">All my Pages</option>{data?.pages.map((page: any) => <option key={page.id} value={page.id}>{page.name}</option>)}</select></label>
   <label className="max-w-full text-xs font-medium">Creative<select aria-label="Calendar creative" disabled={syncing} value={adId} onChange={e => setAdId(e.target.value)} className={`${fieldStyle} mt-1 block max-w-[280px]`}><option value="">All verified ad origins</option><option value="unknown">Unknown / unattributed inquiries</option>{data?.inventory.map((ad: any) => <option key={`${ad.page_id}:${ad.ad_id}`} value={ad.ad_id}>{ad.ad_name || ad.ad_title || ad.ad_id}</option>)}</select></label>
   <button disabled={loading || syncing} onClick={() => void refresh()} className={`${fieldStyle} disabled:opacity-40`}>Refresh results</button>
   <button disabled={syncing || !connection?.accounts?.length || !data || adId === 'unknown'} onClick={() => void sync()} className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40">{syncing ? 'Importing actual spend…' : remaining ? `Continue spend import (${remaining})` : 'Import actual spend and metrics'}</button>
  </div>
  {(connection?.status !== 'ready' || !connection?.accounts?.length) && <div className="space-y-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900"><p>{connection?.message || 'Checking Facebook ad-account access…'}</p><button className="rounded border border-amber-300 px-3 py-2 text-sm" onClick={() => void signIn('facebook', { callbackUrl: '/dashboard/ad-calendar?' + queryFor() }, { scope: FACEBOOK_PERMISSION_SCOPE + ',ads_read', auth_type: 'rerequest' })}>Connect read-only ad access</button> <a href="/dashboard/ad-quality" className="underline">Manage ad connection</a></div>}
  {(error || importError) && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error || importError}</p>}{notice && <p role="status" className="rounded-lg bg-blue-50 p-3 text-sm text-blue-900">{notice}</p>}
  {!data ? <p role="status" className="text-sm text-slate-500">{loading ? 'Loading the inquiry cohorts and actual spend…' : 'No report available.'}</p> : <>
   <p className="text-xs text-slate-500">Outcomes as of {dateTime(data.outcome_as_of)}. Amounts cover imported ads with verified Page ownership. Stage conversions are separate from verified payments. Revenue is credited to the first verified ad origin.</p>
   {data.pages.some((page: any) => (!pageId || page.id === pageId) && page.messaging_auto_tag_last_error) && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{data.pages.filter((page: any) => (!pageId || page.id === pageId) && page.messaging_auto_tag_last_error).length} Page(s) have synchronization errors. Their recorded stage outcomes may be stale until access is restored. <a href="/dashboard/connect" className="underline">Review Page connections</a></p>}
   {!!summary.legacy_dates && <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">{summary.legacy_dates} inquiries use older CRM dates that have not been verified against the original conversation. These remain marked as legacy dates.</p>}
   {mixedMoney && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Multiple ad currencies are recorded. Select one Page or creative to compare money metrics. Currencies are never converted or combined.</p>}
   {!!summary.spend.timezone_mismatch && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Some ad-account days ({summary.spend.account_timezones.join(', ') || 'timezone unavailable'}) do not match Philippine day boundaries. Their spend is retained in its native reporting dates; PHT cost and profit ratios remain unavailable.</p>}
   <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
    <Card label="Actual ad spend" note={`${summary.spend.covered_ad_days} / ${summary.spend.expected_ad_days} ad-days covered. Unimported days are unknown.`}>{summary.spend.amount != null ? money(summary.spend.amount, summary.spend.currency) : 'Incomplete'}</Card>
    <Card label={adId === 'unknown' ? 'Unattributed inquiries' : 'Linked ad inquiries'} note={`${data.unattributed.inquiries} other / unknown-source inquiries in this scope.`}>{number(summary.inquiries)}</Card>
    <Card label="Converted lead stages" note={`${summary.converted_later} recorded on later days · ${pct(summary.conversion_rate)} of the original cohort`}>{number(summary.converted)}</Card>
    <Card label="Verified paying customers" note={`${pct(summary.payer_rate)} payer rate · CPA ${money(summary.cpa, summary.spend.currency)}`}>{number(summary.payers)}</Card>
    <Card label="Recorded revenue after refunds" note="Includes later deposits and balances from this cohort. Missing payment records remain unverified."><Revenue rows={summary.finance} /></Card>
    <Card label="Salary allowance · 40%" note="40% of positive recorded revenue after refunds per acquisition-day/creative cohort. This is a calculated allowance."><Revenue rows={summary.finance} field="salary" /></Card>
    <Card label="Profit after salary and ads" note="Other expenses and taxes are excluded. Partial payment records can understate returns.">{money(summary.profit, summary.spend.currency)}</Card>
    <Card label="Gross / net ROAS" note="Gross = revenue ÷ ads. Net = profit after salary and ads ÷ ads.">{roas(summary.gross_roas)} / {roas(summary.net_roas)}</Card>
   </div>
   <section className="rounded-xl border border-slate-200 bg-white p-3 md:p-5" aria-label="Advertising heat map calendar">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">{new Date(month + '-01T12:00:00Z').toLocaleDateString('en-PH', { month: 'long', year: 'numeric', timeZone: 'Asia/Manila' })}</h2><label className="text-xs">Color by <select aria-label="Calendar heat metric" className={fieldStyle} value={metric} onChange={e => setMetric(e.target.value)}>{Object.entries(heatMetrics).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label></div>
    <p className="mb-2 text-xs text-slate-500">{heat.label}{currencies.size === 1 ? ` · Ad spend currency: ${[...currencies][0]}` : ''}. Darker means a larger magnitude.{['spend', 'cpa', 'messaging'].includes(metric) && ' Costs are shown as positive expenses; green does not mean a lower cost.'}</p>
    <div aria-label="Heat map color legend" className="mb-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-600">
     <span className="flex items-center gap-1.5"><i aria-hidden="true" className="h-3 w-3 rounded bg-red-600" />Negative</span>
     <span className="flex items-center gap-1.5"><i aria-hidden="true" className="h-3 w-3 rounded bg-green-600" />Positive</span>
     <span className="flex items-center gap-1.5"><i aria-hidden="true" className="h-3 w-3 rounded border border-slate-300 bg-white" />Zero</span>
     <span className="flex items-center gap-1.5"><i aria-hidden="true" className="h-3 w-3 rounded border border-slate-300 bg-slate-100" />Unavailable</span>
    </div>
    <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-slate-500 md:gap-2 md:text-xs">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(label => <span key={label} className="pb-2">{label}</span>)}
     {Array.from({ length: blank }, (_, index) => <div key={`blank-${index}`} />)}
     {data.days.map((row: any) => <button key={row.day} aria-label={`Inquiry cohort ${row.day}`} aria-describedby={`day-values-${row.day}`} aria-pressed={day === row.day} disabled={row.future} onClick={() => { setDay(row.day); setPeopleOffset(0); }}
      style={calendarHeat(row.future ? null : heatValue(row), scale)} className={`min-w-0 rounded-lg border px-1 py-2 text-left disabled:opacity-35 md:min-h-[105px] md:p-3 ${day === row.day ? 'ring-2 ring-slate-900 ring-offset-1' : ''}`}>
      <span className="block text-xs font-semibold">{Number(row.day.slice(-2))}{row.partial && <span className="hidden text-[10px] font-normal md:inline"> · today</span>}</span>
      <b className="mt-2 block break-words text-[10px] md:text-lg">{row.future ? '—' : formatCell(heatValue(row))}</b>
      {metric !== 'spend' && <span className="mt-1 block text-[8px] md:text-[11px]"><span className="md:hidden">A{row.spend.amount == null ? '—' : `${mixedMoney ? row.spend.currency : ''}${new Intl.NumberFormat('en-PH', { notation: 'compact', maximumFractionDigits: 1 }).format(row.spend.amount)}`}</span><span className="hidden md:inline">A {row.spend.amount == null ? '—' : `${row.spend.currency} ${new Intl.NumberFormat('en-PH', { notation: 'compact', maximumFractionDigits: 1 }).format(row.spend.amount)}`}</span></span>}
      <span className="mt-1 block text-[8px] md:text-[11px]"><span className="md:hidden">{row.inquiries}L {row.converted}C</span><span className="hidden md:inline">L {row.inquiries} · C {row.converted}</span></span>
      <span className="sr-only" id={`day-values-${row.day}`}>{heat.label}: {formatCell(heatValue(row))}. Ad spend: {money(row.spend.amount, row.spend.currency)}. {row.inquiries} linked inquiries and {row.converted} converted stages.</span>
     </button>)}
    </div><p className="mt-3 text-xs text-slate-500">A = ad spend, L = linked inquiries, C = current Converted stages from those same leads. Today is provisional. A later conversion updates its original inquiry date.</p>
   </section>
   {selected && <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 md:p-5" aria-label="Selected inquiry day">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">Inquiry cohort · {day}</h2><p className="mt-1 text-xs text-slate-500">Includes outcomes after this day ended.</p></div><button className={fieldStyle} onClick={() => { setShowPeople(value => !value); setPeopleOffset(0); }}>View cohort contacts</button></div>
    {loading || data.selected_day !== day ? <p className="text-sm text-slate-500">Updating this day…</p> : <>
     <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Card label="Spend / cost per linked inquiry">{money(selected.spend.amount, selected.spend.currency)}<p className="mt-1 text-sm font-normal">{money(selected.cost_per_inquiry, selected.spend.currency)} per inquiry</p></Card><Card label="Meta messaging conversations / cost">{number(selected.messaging_started)}<p className="mt-1 text-sm font-normal">{money(selected.cost_per_messaging, selected.spend.currency)} per conversation</p></Card><Card label="Converted now / on later days">{selected.converted} / {selected.converted_later}<p className="mt-1 text-sm font-normal">{pct(selected.conversion_rate)} stage conversion rate</p></Card><Card label="Verified customers / CPA">{selected.payers}<p className="mt-1 text-sm font-normal">{money(selected.cpa, selected.spend.currency)} per customer</p></Card></div>
     <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Card label="Recorded revenue"><Revenue rows={selected.finance} /></Card><Card label="40% salary"><Revenue rows={selected.finance} field="salary" /></Card><Card label="Profit after salary and ads">{money(selected.profit, selected.spend.currency)}</Card><Card label="Gross / net ROAS">{roas(selected.gross_roas)} / {roas(selected.net_roas)}</Card></div>
     <div className="overflow-x-auto"><table className="w-full text-sm"><caption className="mb-2 text-left text-xs text-slate-500">Calendar days between inquiry and the first recorded outcome, in PHT</caption><thead><tr>{['Outcome', 'Same day', 'Next day', '2–7 days', '8–30 days', '31+ days'].map(label => <th key={label} className="p-2 text-left text-xs">{label}</th>)}</tr></thead><tbody>{[['Converted stage', selected.stage_lags], ['Verified first receipt', selected.paid_lags]].map(([label, values]: any) => <tr key={label} className="border-t"><th className="p-2 text-left text-xs">{label}</th>{values.map((value: number, index: number) => <td className="p-2" key={index}>{value}</td>)}</tr>)}</tbody></table></div>
     {!!selected.conversion_time_unknown && <p className="text-xs text-amber-800">{selected.conversion_time_unknown} Converted stage(s) have no original conversion timestamp; they are not guessed into a timing bucket.</p>}
     {!!selected.pre_inquiry_payments && <p className="text-xs text-amber-800">{selected.pre_inquiry_payments} payment record(s) precede the known inquiry and are excluded pending date verification.</p>}
     {!!selected.unattributed_inquiries && adId !== 'unknown' && <button className="text-sm text-blue-700 underline" onClick={() => setAdId('unknown')}>Review {selected.unattributed_inquiries} unknown-source inquiries for this day</button>}
    </>}
    {showPeople && <div className="space-y-3 border-t pt-4"><label className="text-xs">Contacts <select aria-label="Cohort contact status" className={fieldStyle} value={peopleStatus} onChange={e => { setPeopleStatus(e.target.value); setPeopleOffset(0); }}>{[['all', 'All cohort inquiries'], ['converted', 'Converted stages'], ['paid', 'Verified paying customers'], ['unconverted', 'Other stages']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
     {!people ? <p className="text-sm text-slate-500">Loading cohort contacts…</p> : <><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{['Contact', 'Inquiry (PHT)', 'Current stage', 'First Converted stage', 'First verified receipt'].map(label => <th key={label} className="p-2 text-left text-xs">{label}</th>)}</tr></thead><tbody>{people.contacts.map((contact: any) => <tr key={contact.id} className="border-t"><td className="p-2"><a className="text-blue-700 underline" href={`/dashboard/contacts/${contact.id}?pageId=${contact.page_id}`}>{contact.name || 'Messenger contact'}</a></td><td className="p-2 text-xs">{dateTime(contact.inquiry_at)}</td><td className="p-2 text-xs">{contact.stage?.replaceAll('_', ' ')}</td><td className="p-2 text-xs">{dateTime(contact.converted_at)}</td><td className="p-2 text-xs">{dateTime(contact.paid_at)}</td></tr>)}</tbody></table>{!people.contacts.length && <p className="py-3 text-sm text-slate-500">No contacts match this filter.</p>}</div><div className="flex items-center justify-between gap-2"><button disabled={!peopleOffset} onClick={() => setPeopleOffset(value => Math.max(0, value - 25))} className={`${fieldStyle} disabled:opacity-40`}>Previous contacts</button><span className="text-xs">{people.total} matching contacts</span><button disabled={peopleOffset + 25 >= people.total} onClick={() => setPeopleOffset(value => value + 25)} className={`${fieldStyle} disabled:opacity-40`}>Next contacts</button></div></>}
    </div>}
   </section>}
   <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 md:p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">Creative performance</h2><select aria-label="Creative metrics period" value={creativeMode} onChange={e => setCreativeMode(e.target.value)} className={fieldStyle}><option value="day">Selected inquiry day</option><option value="month">Entire inquiry month</option></select></div>
    <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{['Creative', 'Spend', 'Meta conversations / cost', 'Linked inquiries', 'Converted / rate', 'Verified payers / CPA', 'Recorded revenue', 'Profit', 'Gross / net ROAS', 'Delivery metrics'].map(label => <th key={label} className="p-2 text-left text-xs">{label}</th>)}</tr></thead><tbody>{creativeRows.slice((creativePage - 1) * 25, creativePage * 25).map((row: any) => <tr key={`${row.ad.page_id}:${row.ad.ad_id}`} className="border-t align-top"><td className="min-w-[200px] p-2"><b>{row.ad.ad_name || row.ad.ad_title || row.ad.ad_id}</b><p className="mt-1 text-xs text-slate-500">{row.ad.campaign_name || 'Campaign unavailable'} · {row.ad.adset_name || 'Ad set unavailable'}</p><AdCreativePreview ad={row.ad} /></td><td className="whitespace-nowrap p-2">{money(row.spend.amount, row.spend.currency)}</td><td className="p-2">{number(row.messaging_started)}<p className="text-xs text-slate-500">{money(row.cost_per_messaging, row.spend.currency)}</p></td><td className="p-2">{row.inquiries}</td><td className="p-2">{row.converted}<p className="text-xs">{pct(row.conversion_rate)}</p><p className="text-xs text-slate-500">{row.converted_later} later days</p></td><td className="p-2">{row.payers}<p className="text-xs">{money(row.cpa, row.spend.currency)}</p></td><td className="whitespace-nowrap p-2"><Revenue rows={row.finance} /></td><td className="whitespace-nowrap p-2">{money(row.profit, row.spend.currency)}</td><td className="p-2">{roas(row.gross_roas)} / {roas(row.net_roas)}</td><td className="min-w-[150px] p-2"><details><summary className="cursor-pointer text-xs underline">Delivery details</summary><dl className="mt-2 space-y-2 text-xs">{[['Impressions', number(row.impressions)], ['All clicks / CPC', `${number(row.clicks)} / ${money(row.cpc, row.spend.currency)}`], ['Link clicks / CTR', `${number(row.link_clicks)} / ${pct(row.link_ctr)}`], ['All-click CTR / CPM', `${pct(row.ctr)} / ${money(row.cpm, row.spend.currency)}`], ['Reach / frequency', `${number(row.reach)} / ${number(row.frequency)}`], ['Video plays', number(row.video_plays)], ['ThruPlays', number(row.video_thruplays)], ['100% video plays', number(row.video_complete)]].map(([label, value]) => <div key={label}><dt className="text-slate-500">{label}</dt><dd>{value}</dd></div>)}</dl></details></td></tr>)}</tbody></table>{!creativeRows.length && <p className="py-4 text-sm text-slate-500">No verified creative inventory in this selection. Unknown-source revenue receives no guessed ad allocation.</p>}</div>
    {creativeRows.length > 25 && <div className="flex items-center justify-between gap-3"><button disabled={creativePage === 1} onClick={() => setCreativePage(value => value - 1)} className={`${fieldStyle} disabled:opacity-40`}>Previous creatives</button><span className="text-xs">Page {creativePage} of {Math.ceil(creativeRows.length / 25)}</span><button disabled={creativePage * 25 >= creativeRows.length} onClick={() => setCreativePage(value => value + 1)} className={`${fieldStyle} disabled:opacity-40`}>Next creatives</button></div>}
   </section>
   <details className="rounded-xl border border-slate-200 p-4"><summary className="cursor-pointer font-medium">Definitions, coverage and financial formulas</summary><dl className="mt-4 space-y-3 text-sm">{Object.entries(data.definitions).map(([key, value]) => <div key={key}><dt className="text-xs font-semibold capitalize text-slate-500">{key.replaceAll('_', ' ')}</dt><dd className="mt-1 leading-6">{String(value)}</dd></div>)}</dl></details>
  </>}
 </div>;
}
