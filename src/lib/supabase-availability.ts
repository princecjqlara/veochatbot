import { isSupabaseUnavailable } from './supabase-errors';

/** Protect each warm server worker; persisted queue leases still coordinate
 * separate workers. Successful recovery probes restore normal throughput. */
export function createSupabaseAvailabilityGate(fetcher: typeof fetch): typeof fetch {
    let failures = 0, reopenAt = 0, probing = false, generation = 0;
    const failed = () => {
        failures = Math.min(5, failures + 1);
        reopenAt = Date.now() + Math.min(30_000, 2_000 * 2 ** (failures - 1));
        generation++;
    };
    return async (input, init) => {
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        signal?.throwIfAborted();
        if (probing || Date.now() < reopenAt) return new Response(JSON.stringify({
            code: 'SUPABASE_CIRCUIT_OPEN', message: 'The database is recovering. Please retry shortly.'
        }), { status: 503, headers: { 'Content-Type': 'application/json',
            'Retry-After': String(Math.max(1, Math.ceil((reopenAt - Date.now()) / 1000))) } });
        const probe = reopenAt > 0, startedGeneration = generation;
        if (probe) probing = true;
        try {
            const response = await fetcher(input, init);
            if (response.status === 429 || response.status >= 500) failed();
            else if (generation === startedGeneration) { failures = 0; reopenAt = 0; }
            return response;
        } catch (error) {
            if (!signal?.aborted && isSupabaseUnavailable(error)) failed();
            throw error;
        } finally { if (probe) probing = false; }
    };
}
