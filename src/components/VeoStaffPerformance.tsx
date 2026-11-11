'use client';
import { useState } from 'react';
import Link from 'next/link';

const money = (value: number | null, currency: string) => value == null ? 'Unavailable' : new Intl.NumberFormat('en-PH', { style: 'currency', currency }).format(value / 100);
const decimal = (value: number | null) => value == null ? 'Unavailable' : value.toFixed(2);
const hours = (value: any) => value == null ? 'Unavailable' : Number(value) < 24 ? `${Number(value).toFixed(2)} hours` : `${(Number(value) / 24).toFixed(2)} days`;
const percent = (value: number | null) => value == null ? 'Unavailable' : `${(value * 100).toFixed(1)}%`;
const colors = ['#2563eb', '#059669', '#9333ea', '#d97706'];
type Series = { label: string; values: Array<number | null>; color: string };

function Trend({ label, labels, series, format, axisFormat = format }: { label: string; labels: string[]; series: Series[]; format: (n: number) => string; axisFormat?: (n: number) => string }) {
    const values = series.flatMap(row => row.values.filter((value): value is number => value != null && Number.isFinite(value)));
    if (!labels.length) return <p className="text-sm text-slate-500">No completed employment dates to graph.</p>;
    const min = Math.min(0, ...values), max = Math.max(1, ...values), span = max - min;
    const x = (i: number) => 64 + (labels.length > 1 ? i / (labels.length - 1) : 0.5) * 620;
    const y = (value: number) => 170 - (value - min) / span * 140;
    const ticks = [min, min + span / 2, max];
    return <div className="space-y-2">
        <svg viewBox="0 0 720 210" className="w-full min-w-0" role="img" aria-label={label}>
            <title>{label}. Point details are also available in the daily data table.</title>
            {ticks.map((tick, index) => <g key={index}><line x1="64" x2="684" y1={y(tick)} y2={y(tick)} stroke="#cbd5e1" /><text x="58" y={y(tick) + 4} textAnchor="end" fontSize="10" fill="#475569">{axisFormat(tick)}</text></g>)}
            {series.map(row => {
                const segments: string[] = []; let segment = '';
                row.values.forEach((value, index) => { if (value == null || !Number.isFinite(value)) { if (segment) segments.push(segment); segment = ''; } else segment += `${segment ? ' L' : 'M'}${x(index)},${y(value)}`; });
                if (segment) segments.push(segment);
                return <g key={row.label}>{segments.map((path, index) => <path key={index} d={path} fill="none" stroke={row.color} strokeWidth="2" />)}{row.values.map((value, index) => value == null ? null : <circle key={index} cx={x(index)} cy={y(value)} r="3" fill={row.color}><title>{labels[index]}: {row.label} {format(value)}</title></circle>)}</g>;
            })}
            {[...new Set([0, Math.round((labels.length - 1) / 2), labels.length - 1])].map(index => <text key={index} x={x(index)} y="195" textAnchor="middle" fontSize="11" fill="#475569">{labels[index]}</text>)}
        </svg>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label={`${label} legend`}>{series.map(row => <li key={row.label}><span aria-hidden="true" className="inline-block h-2 w-2 rounded-full mr-1" style={{ backgroundColor: row.color }} />{row.label}</li>)}</ul>
        {!values.length && <p className="text-xs text-slate-500">Values are unavailable. Missing cost data is shown as a gap.</p>}
    </div>;
}

function Turnaround({ title, data, description }: { title: string; data: any; description: string }) {
    return <section className="rounded-lg border p-4 space-y-2" aria-label={title}>
        <h5 className="font-semibold">{title}</h5><p className="text-xs text-slate-600">{description}</p>
        <p className="text-sm">Average <strong>{hours(data?.mean_hours)}</strong> · Median {hours(data?.median_hours)} · {data?.count || 0} recorded completions</p>
        {(['fastest', 'slowest'] as const).map(key => <p className="text-sm" key={key}><span className="capitalize">{key}</span>: <strong>{hours(data?.[key]?.hours)}</strong>{data?.[key] && <> · <Link className="underline" href={`/dashboard/contacts/${data[key].contact_id}?pageId=${data[key].page_id}`}>{data[key].contact_name || 'Open client'}</Link> · {data[key].page_name}</>}</p>)}
        {!data?.count && <p className="text-xs text-slate-500">No matching recorded timestamps. No duration is inferred from chat or a payment screenshot.</p>}
    </section>;
}

export default function VeoStaffPerformance({ data, rankingScope }: { data: any; rankingScope: string }) {
    const [chosenCurrency, setCurrency] = useState(''), [weekdayMetric, setWeekdayMetric] = useState('done');
    const currency = data.currencies.includes(chosenCurrency) ? chosenCurrency : data.currencies[0] || '';
    const final = data.completed_totals.find((row: any) => row.currency === currency);
    const range = data.totals.find((row: any) => row.currency === currency);
    const days = data.days.filter((day: any) => !day.provisional);
    const counts = ['closed', 'done', 'new_clients'];
    const metricNames: Record<string, string> = { closed: 'Closed Deals', done: 'Done Deals', new_clients: 'New clients' };
    const tile = (label: string, value: string | number, detail: string) => <div className="rounded-lg border bg-slate-50 p-3"><p className="text-xs text-slate-600">{label}</p><p className="text-xl font-bold mt-1">{value}</p><p className="text-xs text-slate-600 mt-1">{detail}</p></div>;
    return <section className="space-y-4 border-t pt-4" aria-label="Staff performance insights">
        <div><h4 className="text-lg font-bold">Performance insights</h4><p className="text-xs text-slate-600">Uses the dates and Page selected above. Averages and graphs use {data.completed_days} completed employment dates, including zero-sales dates. Today stays provisional in daily history.</p></div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {tile('Current clients', data.current_clients, 'Current assignments on the selected permitted Pages, across dates.')}
            {tile('New clients in this range', data.new_clients, `${decimal(data.average_new_clients)} per completed day. First recorded assignment to this worker since launch; returning clients are not added twice.`)}
            {tile('Average CD / DD per day', `${decimal(data.average_closed)} / ${decimal(data.average_done)}`, 'Separate Closed Deal and Done Deal milestones; completed employment dates only.')}
            {tile('Best weekday by Done Deals', data.best_weekday?.name || 'No sales history', data.best_weekday ? `${decimal(data.best_weekday.average_done)} DD per observed ${data.best_weekday.name}; ${data.best_weekday.days} sampled dates. Based on averages, not unequal weekday totals.` : 'A recorded Closed or Done Deal is needed to identify a best weekday.')}
            {tile('Days with sales activity', data.sales_days, `${data.zero_sales_days} completed dates with no CD or DD. This is separate from declared attendance above.`)}
            {tile('Clients handled since launch', data.ever_assigned_clients, `${data.clients_with_sales} clients have recorded sale history. Ownership history and current assignments determine the handled count.`)}
            {tile('Overall rank for selected dates', data.overall_ranking?.rank ? `#${data.overall_ranking.rank}` : 'Unranked', `${rankingScope}; all permitted Pages, including when a single Page is selected. ${data.overall_ranking?.peers ? data.overall_ranking.peers + ' eligible peers.' : 'Peer rankings follow your role permissions.'}`)}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
            <Turnaround title="CD to DD: verified payment turnaround" data={data.cd_turnaround} description="Orders first Closed in the selected dates; completed payments may be later than the range. Immediate full payment is 0 hours. This measures payment completion." />
            <Turnaround title="Video production turnaround" data={data.video_turnaround} description="First verified payment to recorded project completion, for work completed in these dates and attributed to this editor. Financial Done Deal and video completion are separate events." />
        </div>
        <section className="rounded-lg border p-4 space-y-3" aria-label="Staff earnings and business profit">
            <div className="flex flex-wrap justify-between gap-3"><h5 className="font-semibold">Daily earnings and business profit</h5>{data.currencies.length > 0 && <label className="text-sm">Currency<select aria-label="Performance currency" className="ml-2 rounded border p-1" value={currency} onChange={event => setCurrency(event.target.value)}>{data.currencies.map((value: string) => <option key={value}>{value}</option>)}</select></label>}</div>
            {final ? <>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    {tile('Average daily gross sales', money(final.average_gross_minor, currency), 'Completed order price before refunds; not business profit.')}
                    {tile('Average daily staff earnings', money(final.average_salary_minor, currency), 'Commission from the existing authoritative salary calculation.')}
                    {tile('Average daily gross profit', money(final.average_gross_profit_minor, currency), 'Verified net completed sales minus staff commission, before advertising and overhead.')}
                    {tile('Average daily estimated net profit', money(final.average_net_profit_minor, currency), `${final.cost_known_days}/${data.completed_days} dates have allocatable ad costs. Subtracts commission and allocated ads; excludes untracked overhead.`)}
                </div>
                <p className="text-xs text-slate-600">Selected-range totals, including provisional today: gross sales {money(range.gross_minor, currency)} · verified net sales {money(range.revenue_minor, currency)} · staff earnings {money(range.salary_minor, currency)} · gross profit {money(range.gross_profit_minor, currency)} · allocated ads {money(range.ad_cost_minor, currency)} · estimated net profit {money(range.net_profit_minor, currency)}. Currencies are never combined.</p>
            </> : <p className="text-sm">No recorded monetary values in this range. Gross sales and staff earnings are 0 recorded; estimated net profit is unavailable without verified cost coverage.</p>}
            <details className="text-xs text-slate-600"><summary className="cursor-pointer underline">How profit and ad costs are calculated</summary><p className="mt-2">{data.cost_model} Page/day ad costs are shared by each seller&apos;s verified net completed sales. This is an allocation estimate, not measured personal ad spend. A day with ad spend and no Page sales cannot be allocated. Page scope uses current grants and recorded sales history.</p></details>
        </section>
        <div className="grid gap-4 xl:grid-cols-2">
            <section className="rounded-lg border p-4 space-y-2"><h5 className="font-semibold">Daily clients and deals</h5><Trend label="Daily clients and Closed and Done Deals" labels={days.map((day: any) => day.work_date)} series={counts.map((key, index) => ({ label: metricNames[key], color: colors[index], values: days.map((day: any) => day[key]) }))} format={value => value.toFixed(0)} /></section>
            <section className="rounded-lg border p-4 space-y-2"><div className="flex flex-wrap justify-between gap-2"><h5 className="font-semibold">Best days of the week</h5><select aria-label="Weekday performance metric" className="rounded border p-1 text-sm" value={weekdayMetric} onChange={event => setWeekdayMetric(event.target.value)}>{counts.map(key => <option key={key} value={key}>{metricNames[key]} per day</option>)}</select></div><Trend label="Average staff performance by weekday" labels={data.weekdays.map((day: any) => day.name.slice(0, 3))} series={[{ label: `${metricNames[weekdayMetric]} per observed weekday`, color: colors[1], values: data.weekdays.map((day: any) => day[`average_${weekdayMetric}`]) }]} format={value => value.toFixed(2)} /><p className="text-xs text-slate-500">Completed dates sampled: {data.weekdays.map((day: any) => `${day.name.slice(0, 3)} ${day.days}`).join(' · ')}. Unsampled weekdays are unavailable.</p></section>
            {currency && <section className="rounded-lg border p-4 space-y-2"><h5 className="font-semibold">Sales, earnings and profit · {currency}</h5><Trend label={`Daily staff sales earnings and profit in ${currency}`} labels={days.map((day: any) => day.work_date)} series={[
                ['Gross sales', 'gross_minor'], ['Gross profit', 'gross_profit_minor'], ['Estimated net profit', 'net_profit_minor'], ['Staff earnings', 'salary_minor']
            ].map(([label, field], index) => ({ label, color: colors[index], values: days.map((day: any) => day.finance.find((row: any) => row.currency === currency)?.[field] ?? null) }))} format={value => money(value, currency)} axisFormat={value => new Intl.NumberFormat('en-PH', { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(value / 100)} /><p className="text-xs text-slate-500">Missing net-profit values leave gaps; they are not plotted as zero.</p></section>}
            <section className="rounded-lg border p-4 space-y-2"><h5 className="font-semibold">Personal response rate</h5><Trend label="Daily attributed staff response rate within 24 hours" labels={days.map((day: any) => day.work_date)} series={[{ label: 'Assigned-client inquiry days answered within 24h', color: colors[0], values: days.map((day: any) => day.reply_rate) }]} format={value => percent(value)} /><p className="text-xs text-slate-500">Observed inquiries with a manual reply attributed to this worker. No inquiries means unavailable, rather than 0%. Capture coverage is shown below.</p></section>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-lg border p-4 space-y-2"><h5 className="font-semibold">Strongest recorded dates</h5><p className="text-xs text-slate-500">Sorted by Done Deals, then Closed Deals. Completed employment dates only.</p>{data.best_dates.length ? data.best_dates.map((day: any) => <p className="text-sm" key={day.work_date}>{day.work_date}: <strong>{day.done} DD · {day.closed} CD</strong> · {day.new_clients} new clients</p>) : <p className="text-sm text-slate-500">No sales milestones in these dates.</p>}</section>
            <section className="rounded-lg border p-4 space-y-2"><h5 className="font-semibold">Rank on each permitted Page</h5><p className="text-xs text-slate-500">Same date range; all permitted Pages are listed. Done Deals, then Closed Deals, with shared ranks for ties. {rankingScope}.</p>{data.page_rankings.length ? data.page_rankings.map((page: any) => <p className="text-sm" key={page.page_id}><strong>{page.page_name}</strong>: {page.rank ? `#${page.rank} of ${page.peers}` : 'Unranked'} · {page.done} DD / {page.closed} CD</p>) : <p className="text-sm text-slate-500">No permitted Page ranking is available.</p>}</section>
        </div>
        <details className="rounded-lg border p-4"><summary className="font-semibold cursor-pointer">Complete daily performance data</summary><p className="my-2 text-xs text-slate-500">Includes provisional today. Money follows the chosen currency. Unknown costs remain unavailable.</p><div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead><tr>{['PHT date', 'New clients', 'CD / DD', 'Personal reply rate', 'Gross sales', 'Staff earnings', 'Gross profit', 'Allocated ads', 'Estimated net profit'].map(label => <th className="border-b p-2 whitespace-nowrap" key={label}>{label}</th>)}</tr></thead><tbody>{data.days.map((day: any) => {
            const financial = day.finance.find((row: any) => row.currency === currency);
            return <tr key={day.work_date}><td className="border-b p-2 whitespace-nowrap">{day.work_date}{day.provisional && ' · Provisional'}</td><td className="border-b p-2">{day.new_clients}</td><td className="border-b p-2">{day.closed} / {day.done}</td><td className="border-b p-2">{percent(day.reply_rate)}</td>{['gross_minor', 'salary_minor', 'gross_profit_minor', 'ad_cost_minor', 'net_profit_minor'].map(field => <td className="border-b p-2 whitespace-nowrap" key={field}>{financial ? money(financial[field], currency) : 'Unavailable'}</td>)}</tr>;
        })}</tbody></table></div></details>
    </section>;
}
