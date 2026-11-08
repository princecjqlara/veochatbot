/** Poll only while visible, wait for each request, and back off after failures. */
export function startAdaptivePolling(task: (signal: AbortSignal) => Promise<unknown>, options: {
    intervalMs: number; immediate?: boolean; maxDelayMs?: number;
    visibility?: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;
}) {
    const visibility = options.visibility ?? (typeof document === 'undefined' ? undefined : document);
    let stopped = false, running = false, failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
    const schedule = () => {
        if (stopped || visibility?.hidden) return;
        timer = setTimeout(() => void run(), Math.min(options.maxDelayMs ?? 120_000, options.intervalMs * 2 ** failures));
    };
    const run = async () => {
        if (stopped || running || visibility?.hidden) return;
        running = true; controller = new AbortController();
        try { await task(controller.signal); failures = 0; }
        catch { failures = Math.min(5, failures + 1); }
        finally { running = false; schedule(); }
    };
    const onVisibility = () => {
        if (timer) clearTimeout(timer);
        if (!visibility?.hidden && !running) { failures = 0; void run(); }
    };
    visibility?.addEventListener('visibilitychange', onVisibility);
    if (options.immediate) void run(); else schedule();
    return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        controller?.abort();
        visibility?.removeEventListener('visibilitychange', onVisibility);
    };
}
