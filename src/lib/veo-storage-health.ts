import { assertVeoDatabaseUrl } from './veo-database-scope';
import { parseDatabaseResourceMetrics } from './database-resource-health';

export function parseStorageMetrics(source: string) {
    const values = new Map<string, number>();
    for (const line of source.split('\n')) {
        const sample = /^(node_filesystem_size_bytes|node_filesystem_avail_bytes|pg_wal_size_mb)(?:\{([^}]*)\})?\s+([\d.eE+-]+)(?:\s|$)/.exec(line);
        if (!sample || sample[1].startsWith('node_') && !/(?:^|,)mountpoint="\/data"(?:,|$)/.test(sample[2] || '')) continue;
        const value = Number(sample[3]);if (!Number.isFinite(value) || value < 0) continue;
        if (values.has(sample[1])) throw Error('Ambiguous database disk metrics');
        values.set(sample[1], value);
    }
    const size = values.get('node_filesystem_size_bytes'), available = values.get('node_filesystem_avail_bytes');
    if (!size || available == null || available > size) throw Error('Database disk metrics unavailable');
    return { available: true, disk_size_bytes: Math.round(size), disk_available_bytes: Math.round(available), wal_bytes: values.has('pg_wal_size_mb') ? Math.round(values.get('pg_wal_size_mb')! * 1048576) : null,
        ...parseDatabaseResourceMetrics(source) };
}

export async function readStorageMetrics() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw Error('Database monitoring is not configured');assertVeoDatabaseUrl(url);
    const response = await fetch(new URL('/customer/v1/privileged/metrics', url), { headers: { Authorization: 'Basic ' + Buffer.from('service_role:' + key).toString('base64') }, cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw Error('Database monitoring is temporarily unavailable');
    const body = await response.text();if (body.length > 5000000) throw Error('Unexpected monitoring response');
    return parseStorageMetrics(body);
}

/** Pause optional bulk growth, never turn a skipped import into success. */
export async function requireStorageForOptionalWork(db: any) {
    const result = await db.rpc('veo_storage_status');
    if (result.error || !result.data || result.data.optional_work_paused !== false) throw Object.assign(Error('Bulk processing is paused while database storage needs attention. Existing data remains available; check Collection health.'), { status: 503, code: 'STORAGE_ATTENTION' });
    return result.data;
}
