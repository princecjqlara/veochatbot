const retryableStatuses = new Set([502, 503, 504, 520, 521, 522, 523, 524]);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const SUPABASE_REQUEST_TIMEOUT_MS = 10_000;

function requestSignal(input: RequestInfo | URL, init?: RequestInit) {
    return init?.signal ?? (input instanceof Request ? input.signal : undefined);
}

async function fetchSupabaseOnce(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const parentSignal = requestSignal(input, init);
    const abortFromParent = () => controller.abort(parentSignal?.reason);
    parentSignal?.throwIfAborted();
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    const timeout = setTimeout(() => controller.abort(Object.assign(new Error('Supabase request timed out'), {
        code: 'SUPABASE_REQUEST_TIMEOUT'
    })), SUPABASE_REQUEST_TIMEOUT_MS);
    const cleanup = () => {
        clearTimeout(timeout);
        parentSignal?.removeEventListener('abort', abortFromParent);
    };
    try {
        const response = await globalThis.fetch(input, { ...init, signal: controller.signal });
        controller.signal.throwIfAborted();
        if (!response.body) { cleanup(); return response; }
        const reader = response.body.getReader();
        let settled = false;
        // fetch resolves at the headers. Keep the deadline alive until the SDK
        // consumes the body, including a stalled JSON response after HTTP 200.
        let abortBody: () => void;
        const finish = () => {
            settled = true;
            cleanup();
            controller.signal.removeEventListener('abort', abortBody);
        };
        const body = new ReadableStream<Uint8Array>({
            start(stream) {
                abortBody = () => {
                    if (settled) return;
                    finish();
                    stream.error(controller.signal.reason);
                    void reader.cancel(controller.signal.reason).catch(() => {});
                };
                controller.signal.addEventListener('abort', abortBody, { once: true });
                if (controller.signal.aborted) abortBody();
            },
            async pull(stream) {
                try {
                    const { done, value } = await reader.read();
                    if (settled) return;
                    if (done) { finish(); stream.close(); }
                    else stream.enqueue(value);
                } catch (error) {
                    if (settled) return;
                    finish();
                    stream.error(error);
                }
            },
            cancel(reason) { finish(); return reader.cancel(reason); }
        });
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
        cleanup();
        if (controller.signal.aborted) throw controller.signal.reason;
        throw error;
    }
}

/** Retry only idempotent reads. A timed-out write may already have reached Postgres. */
export async function supabaseFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const canRetry = method === 'GET' || method === 'HEAD';
    const parentSignal = requestSignal(input, init);
    let response: Response | undefined;

    for (let attempt = 0; attempt < (canRetry ? 3 : 1); attempt++) {
        parentSignal?.throwIfAborted();
        if (attempt) await sleep(attempt * 250);
        parentSignal?.throwIfAborted();
        try {
            response = await fetchSupabaseOnce(input, init);
            if (!canRetry || !retryableStatuses.has(response.status) || attempt === 2) break;
            await response.body?.cancel();
        } catch (error) {
            response = undefined;
            if (parentSignal?.aborted || !canRetry || attempt === 2) throw error;
        }
    }

    if (!response) throw new Error('Supabase response unavailable');
    const isCloudflareTimeout = response.status >= 520 && response.status <= 524;
    const isHtmlServerError = response.status >= 500 && response.headers.get('content-type')?.includes('text/html');
    if (!isCloudflareTimeout && !isHtmlServerError) return response;

    await response.body?.cancel();
    const ray = response.headers.get('cf-ray');
    return new Response(JSON.stringify({
        message: `Supabase API temporarily unavailable (HTTP ${response.status})`,
        code: `SUPABASE_UPSTREAM_${response.status}`
    }), {
        status: response.status,
        headers: {
            'content-type': 'application/json',
            ...(ray ? { 'x-supabase-upstream-ray': ray } : {})
        }
    });
}
