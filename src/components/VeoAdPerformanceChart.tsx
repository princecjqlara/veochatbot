'use client';
import { useEffect, useRef, useState } from 'react';
import { CREATIVE_CHART_METRICS, creativeChartValue, formatCreativeChartValue } from '@/lib/veo-creative-chart';

export default function VeoAdPerformanceChart({ rows, metricKey, currency }: { rows: any[]; metricKey: string; currency: string }) {
    const [selectedDay, setSelectedDay] = useState('');
    const container = useRef<HTMLDivElement>(null), [chartWidth, setChartWidth] = useState(900);
    useEffect(() => {
        if (!container.current || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(entries => { const width = entries[0]?.contentRect.width; if (width > 0) setChartWidth(Math.max(280, Math.floor(width))); });
        observer.observe(container.current); return () => observer.disconnect();
    }, []);
    const metric = CREATIVE_CHART_METRICS.find(m => m.key === metricKey) || CREATIVE_CHART_METRICS[0];
    const points = rows.map(row => ({ day: row.day, value: creativeChartValue(row, metric, currency) }));
    const known = points.flatMap(p => p.value == null ? [] : [p.value]);
    const low = Math.min(0, ...known), maximum = Math.max(0, ...known), high = maximum === low ? low + 1 : maximum, span = high - low;
    const left = 100, top = 24, width = chartWidth - left - 20, height = 190;
    const x = (i: number) => left + (points.length === 1 ? width / 2 : i / Math.max(1, points.length - 1) * width);
    const y = (v: number) => top + (high - v) / span * height;
    const active = points.find(p => p.day === selectedDay) || points[points.length - 1];
    const segments: string[] = []; let path = '';
    points.forEach((point, i) => {
        if (point.value == null) { if (path) segments.push(path); path = ''; return; }
        path += `${path ? ' L' : 'M'}${x(i)},${y(point.value)}`;
    });
    if (path) segments.push(path);
    return <div ref={container} className="min-w-0 rounded-lg border p-3 space-y-3" aria-label="Ad performance graph">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{metric.label}</h3><span className="text-xs text-slate-500">{known.length} of {points.length} days available</span></div>
        {!points.length ? <p className="text-sm text-slate-600">No daily rows for this ad and period.</p> : <>
            <svg viewBox={`0 0 ${chartWidth} 260`} className="w-full h-64" role="img" aria-label={`${metric.label} by day`}>
                <title>{metric.label} by day. Missing dates are gaps. Exact values are available in the day selector and daily table.</title>
                {[high, low + span / 2, low].map((value, i) => <g key={i}>
                    <line x1={left} x2={left + width} y1={y(value)} y2={y(value)} stroke="#e2e8f0" />
                    <text x={left - 8} y={y(value) + 4} textAnchor="end" fontSize="11" fill="#475569">{formatCreativeChartValue(value, metric, currency)}</text>
                </g>)}
                <line x1={left} x2={left + width} y1={y(0)} y2={y(0)} stroke="#94a3b8" />
                {segments.map((d, i) => <path key={i} d={d} fill="none" stroke="#059669" strokeWidth="2.5" />)}
                {points.map((point, i) => point.value == null ? null : <circle key={point.day} cx={x(i)} cy={y(point.value)} r={active?.day === point.day ? 5 : 3} fill={point.value < 0 ? '#dc2626' : '#047857'} onClick={() => setSelectedDay(point.day)}><title>{point.day}: {formatCreativeChartValue(point.value, metric, currency)}</title></circle>)}
                {points.filter((_, i) => i === 0 || i === points.length - 1 || (chartWidth > 560 && points.length > 6 && i === Math.floor(points.length / 2))).map(point => <text key={point.day} x={x(points.indexOf(point))} y="244" textAnchor={point === points[points.length - 1] && points.length > 1 ? 'end' : 'middle'} fontSize="11" fill="#475569">{point.day}</text>)}
            </svg>
            <div className="flex flex-wrap items-end gap-3"><label className="text-sm">Inspect day<select className="block rounded border p-2" value={active?.day || ''} onChange={e => setSelectedDay(e.target.value)}>{points.map(point => <option key={point.day} value={point.day}>{point.day}</option>)}</select></label><p className="text-sm" aria-live="polite">{active?.day}: <strong>{formatCreativeChartValue(active?.value ?? null, metric, currency)}</strong></p></div>
            {!known.length && <p className="text-sm text-amber-800">This metric is unavailable for these dates. Connect Meta Ads and fetch this period; missing or incomplete metrics remain unavailable.</p>}
        </>}
        <p className="text-xs text-slate-500">Gaps mean unavailable, not zero. Reach and frequency are daily values; repeat viewers can appear on several days. Sales, ROAS and profit follow each day’s inquiry cohort, including later verified outcomes. Today and incomplete delivery coverage cannot certify final ratios.</p>
    </div>;
}
