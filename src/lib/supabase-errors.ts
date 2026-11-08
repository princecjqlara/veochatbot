/** PostgREST can return transport failures as plain objects instead of Errors. */
export function isSupabaseUnavailable(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const value = error as { code?: string; message?: string; name?: string; status?: number; cause?: unknown };
    if (['DATABASE_UNAVAILABLE', 'SUPABASE_REQUEST_TIMEOUT', 'SUPABASE_CIRCUIT_OPEN', 'PGRST000', 'PGRST001', 'PGRST002', 'PGRST003', '53300', '57P01', '57P02', '57P03', '57014'].includes(value.code || '') ||
        /^SUPABASE_UPSTREAM_5\d\d$/.test(value.code || '') ||
        [502, 503, 504, 520, 521, 522, 523, 524].includes(value.status || 0) || value.name === 'TimeoutError' ||
        /Supabase request timed out|Supabase API temporarily unavailable|fetch failed|Failed to fetch|NetworkError|network request failed/i.test(value.message || '')) return true;
    return !!value.cause && value.cause !== error && isSupabaseUnavailable(value.cause);
}
