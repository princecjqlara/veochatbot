import { isSupabaseTimeoutOrOverload, isSupabaseUnavailable } from './supabase-errors';

/** Protect each warm server worker; persisted queue leases still coordinate
 * separate workers. Successful recovery probes restore normal throughput. */
export function createSupabaseAvailabilityGate(fetcher: typeof fetch): typeof fetch {
    let failures = 0, reopenAt = 0, probing = false, generation = 0;
    const failed = (startedGeneration: number) => {
        // Requests from a failed batch may finish after a successful recovery
        // probe. Their old errors must not restart or extend the cooldown.
        if (startedGeneration !== generation) return;
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
        let bodyOwnsProbe = false;
        if (probe) probing = true;
        const healthy = () => {
            if (generation !== startedGeneration) return;
            failures = 0;reopenAt = 0;
            if (probe) generation++;
        };
        try {
            const response = await fetcher(input, init);
            if (response.status === 429 || response.status >= 500) failed(startedGeneration);
            else if (!probe || !response.body) healthy();
            // Headers can arrive before a stalled response body. Observe body
            // failures too, while preserving cancellation and generation fences.
            if (response.status === 429 || response.status >= 500 || !response.body) return response;
            const reader = response.body.getReader();
            bodyOwnsProbe = probe;
            let settled = false;
            const finish = (complete: boolean) => {
                if (settled) return;
                settled = true;
                if (probe) { if (complete) healthy();probing = false; }
            };
            const body = new ReadableStream<Uint8Array>({
                async pull(controller) {
                    try { const part = await reader.read();if (part.done) { finish(true);controller.close(); } else controller.enqueue(part.value); }
                    catch (error) {
                        if (isSupabaseUnavailable(error) && (!signal?.aborted || isSupabaseTimeoutOrOverload(signal.reason))) failed(startedGeneration);
                        finish(false);
                        controller.error(error);
                    }
                },
                cancel(reason) { finish(false);return reader.cancel(reason); }
            });
            return new Response(body, {status: response.status, statusText: response.statusText, headers: response.headers});
        } catch (error) {
            if (isSupabaseUnavailable(error) && (!signal?.aborted || isSupabaseTimeoutOrOverload(signal.reason))) failed(startedGeneration);
            throw error;
        } finally { if (probe && !bodyOwnsProbe) probing = false; }
    };
}
