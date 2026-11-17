/** PostgREST can return transport failures as plain objects instead of Errors. */
export function isSupabaseUnavailable(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const value = error as { code?: string; message?: string; name?: string; status?: number; cause?: unknown };
    if (['DATABASE_UNAVAILABLE', 'SUPABASE_REQUEST_TIMEOUT', 'SUPABASE_CIRCUIT_OPEN', 'PGRST000', 'PGRST001', 'PGRST002', 'PGRST003', '08000', '08001', '08003', '08006', '08007', '08P01', '53300', '55P03', '57P01', '57P02', '57P03', '57014'].includes(value.code || '') ||
        /^SUPABASE_UPSTREAM_5\d\d$/.test(value.code || '') ||
        [502, 503, 504, 520, 521, 522, 523, 524].includes(value.status || 0) || value.name === 'TimeoutError' ||
        /Supabase request timed out|Supabase API temporarily unavailable|(?:connection|database|statement|lock|query).*timed? ?out|timeout expired|fetch failed|Failed to fetch|NetworkError|network request failed/i.test(value.message || '')) return true;
    return !!value.cause && value.cause !== error && isSupabaseUnavailable(value.cause);
}

/** Repeating these requests adds work to an already saturated database. */
export function isSupabaseTimeoutOrOverload(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const e = error as {code?: string; status?: number; name?: string; message?: string; cause?: unknown};
    return ['DATABASE_UNAVAILABLE','SUPABASE_REQUEST_TIMEOUT','57014','55P03','53300','PGRST003','SUPABASE_UPSTREAM_504','SUPABASE_UPSTREAM_522','SUPABASE_UPSTREAM_524'].includes(e.code || '') ||
        [504,522,524].includes(e.status || 0) || e.name === 'TimeoutError' || /timed out|statement timeout|lock timeout/i.test(e.message || '') ||
        Boolean(e.cause && e.cause !== error && isSupabaseTimeoutOrOverload(e.cause));
}
