export type CreativeChartMetric = { key: string; label: string; format: 'count' | 'money' | 'percent' | 'multiple'; finance?: boolean };
export const CREATIVE_CHART_METRICS: CreativeChartMetric[] = [
    { key: 'impressions', label: 'Impressions', format: 'count' },
    { key: 'reach', label: 'Daily unique reach', format: 'count' },
    { key: 'frequency', label: 'Daily frequency', format: 'multiple' },
    { key: 'messaging_started', label: 'Messaging conversations started', format: 'count' },
    { key: 'cost_per_message_minor', label: 'Cost per messaging conversation started', format: 'money', finance: true },
    { key: 'clicks', label: 'All clicks', format: 'count' },
    { key: 'link_clicks', label: 'Link clicks', format: 'count' },
    { key: 'ctr', label: 'CTR (all clicks)', format: 'percent' },
    { key: 'link_ctr', label: 'Link CTR', format: 'percent' },
    { key: 'cpc_minor', label: 'CPC (all clicks)', format: 'money', finance: true },
    { key: 'cost_per_link_click_minor', label: 'Cost per link click', format: 'money', finance: true },
    { key: 'cpm_minor', label: 'CPM', format: 'money', finance: true },
    { key: 'video_plays', label: 'Video plays', format: 'count' },
    { key: 'video_thruplays', label: 'ThruPlays', format: 'count' },
    { key: 'video_complete', label: '100% video completions', format: 'count' },
    { key: 'video_completion_rate', label: 'Video completion rate', format: 'percent' },
    { key: 'cost_per_thruplay_minor', label: 'Cost per ThruPlay', format: 'money', finance: true },
    { key: 'cost_per_video_play_minor', label: 'Cost per video play', format: 'money', finance: true },
    { key: 'inquiries', label: 'Inquiries by inquiry day', format: 'count' },
    { key: 'converted', label: 'Later conversions by inquiry day', format: 'count' },
    { key: 'paying_clients', label: 'Paying clients by inquiry day', format: 'count' },
    { key: 'cost_per_inquiry_minor', label: 'Cost per inquiry', format: 'money', finance: true },
    { key: 'cost_per_conversion_minor', label: 'Cost per Converted lead', format: 'money', finance: true },
    { key: 'cost_per_acquisition_minor', label: 'Cost per acquired paying client', format: 'money', finance: true },
    { key: 'ad_spend_minor', label: 'Ad spend by day', format: 'money', finance: true },
    { key: 'gross_minor', label: 'Verified receipts by inquiry cohort', format: 'money', finance: true },
    { key: 'net_minor', label: 'Net profit/loss by inquiry cohort', format: 'money', finance: true },
    { key: 'gross_roas', label: 'Revenue ROAS by inquiry cohort', format: 'multiple', finance: true },
    { key: 'net_roas', label: 'ROAS after commission by inquiry cohort', format: 'multiple', finance: true },
    { key: 'profit_roi', label: 'Profit ROI by inquiry cohort', format: 'percent', finance: true }
];
export function creativeChartValue(row: any, metric: CreativeChartMetric, currency: string): number | null {
    const finance = row.finance?.find((f: any) => f.currency === currency);
    const provisionalCost = row.delivery_provisional && ['cpc_minor', 'cost_per_link_click_minor', 'cpm_minor', 'cost_per_message_minor', 'cost_per_thruplay_minor', 'cost_per_video_play_minor'].includes(metric.key) ? finance?.provisional_delivery_costs?.[metric.key] : null;
    const value = metric.finance ? finance?.[metric.key] ?? provisionalCost : row[metric.key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
export function formatCreativeChartValue(value: number | null, metric: CreativeChartMetric, currency: string): string {
    if (value == null) return 'Unavailable';
    if (metric.format === 'money') return new Intl.NumberFormat('en-PH', { style: 'currency', currency }).format(value / 100);
    if (metric.format === 'percent') return (value * 100).toFixed(1) + '%';
    if (metric.format === 'multiple') return value.toFixed(2) + '×';
    return new Intl.NumberFormat('en-PH', { maximumFractionDigits: 2 }).format(value);
}
