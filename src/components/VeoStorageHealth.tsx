'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { startAdaptivePolling } from '@/lib/adaptive-polling';
const mb = (bytes: number | null | undefined) => bytes == null ? 'Unavailable' : (bytes / 1000000).toFixed(1) + ' MB';
export default function VeoStorageHealth({ compact = false }: { compact?: boolean }) {
    const [data, setData] = useState<any>(null), [error, setError] = useState(''), [version, setVersion] = useState(0);
    useEffect(() => startAdaptivePolling(async signal => {
        try {
            const response = await fetch('/api/workspace/storage-health', { cache: 'no-store', signal }), body = await response.json();
            if (!response.ok || !['healthy', 'warning', 'critical', 'unknown'].includes(body.status)) throw Error('Database storage monitoring is unavailable. Check Collection health.');
            if (!signal.aborted) { setData(body);setError(''); }
        } catch (e) { if (!signal.aborted) setError(e instanceof Error ? e.message : 'Database monitoring unavailable');throw e; }
    }, { intervalMs: 60000, maxDelayMs: 300000, immediate: true }), [version]);
    const healthy = data?.status === 'healthy' && data?.maintenance_healthy && data?.metrics_fresh && data?.resource_metrics_fresh && !data?.resource_pressure && !error;
    if (compact && (!data && !error || healthy)) return null;
    return <section aria-label="Database storage health" className={`rounded-xl border p-4 text-sm ${healthy ? 'border-slate-200 bg-white' : 'border-amber-300 bg-amber-50'}`}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">{healthy ? 'Database is healthy' : 'Database needs attention'}</h2><button type="button" className="underline" onClick={() => setVersion(v => v + 1)}>Recheck</button></div>
        {error && <p role="alert" className="mt-2">{error}</p>}
        {!data && !error && <p role="status" className="mt-2">Checking storage…</p>}
        {data && <div className="mt-2 space-y-1"><p>Database: {mb(data.database_bytes)} of a {mb(data.database_budget_bytes)} app budget. Data disk available: {mb(data.disk_available_bytes)} of {mb(data.disk_size_bytes)}.</p>
            {!data.metrics_fresh && <p>Disk measurements are unavailable or stale; the last reported values do not establish current free space.</p>}
            {!data.maintenance_healthy && <p>Automatic cleanup has not completed recently. Check the database job before starting a bulk import.</p>}
            {!data.resource_metrics_fresh && <p>Memory and workload measurements are unavailable or stale. Historical imports will resume after a successful check.</p>}
            {data.resource_pressure && <p>Historical imports are paused while the database recovers from {data.resource_pressure_reasons?.includes('low_memory') ? 'low available memory' : data.resource_pressure_reasons?.includes('high_swap') ? 'high swap use' : data.resource_pressure_reasons?.includes('sustained_load') ? 'sustained heavy load' : 'recent resource pressure'}. They resume automatically after recovery.</p>}
            {!compact && data.resources?.memory_total_bytes && <p>Available memory: {mb(data.resources.memory_available_bytes)} of {mb(data.resources.memory_total_bytes)}. Five-minute load: {Number(data.resources.load_5m).toFixed(2)} across {data.resources.cpu_count} CPUs.</p>}
            {data.optional_work_paused && <p>Optional bulk syncs and enrichment are paused. Existing contacts, tags, knowledge and financial records are retained.</p>}
            {!compact && <><p>Disk checked: {data.metrics_ok_at ? new Date(data.metrics_ok_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) + ' PHT' : 'Unavailable'}. Cleanup completed: {data.maintenance_at ? new Date(data.maintenance_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) + ' PHT' : 'Unavailable'}.</p><p className="text-xs text-slate-600">The disk figure includes space used by database files, WAL and system files. Cleanup strips completed webhook payloads after seven days and keeps their duplicate-protection keys. Business records are retained. Recheck reads the latest scheduled measurement.</p></>}
        </div>}
        {compact && <Link href="/dashboard/workspace?view=sync" className="mt-2 inline-block font-semibold underline">Open Collection health</Link>}
    </section>;
}
