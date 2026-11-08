import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSupabaseAvailabilityGate } from '../supabase-availability';
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
it('sheds repeated outage traffic, probes once, then restores normal throughput', async () => {
    let resolveProbe!: (response: Response) => void;
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 522 }))
        .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveProbe = resolve; }))
        .mockImplementation(async () => new Response('[]'));
    const fetch = createSupabaseAvailabilityGate(fetcher);
    expect((await fetch('https://database.example')).status).toBe(522);
    const shed = await Promise.all(Array.from({ length: 30 }, () => fetch('https://database.example')));
    expect(shed.every(response => response.status === 503)).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000);
    const probe = fetch('https://database.example');
    expect((await fetch('https://database.example')).status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(2);
    resolveProbe(new Response('[]')); await probe;
    expect((await fetch('https://database.example')).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(3);
});
it('backs off repeated failures without replaying writes', async () => {
    const fetcher = vi.fn().mockRejectedValue(Object.assign(new Error('Supabase request timed out'), { code: 'SUPABASE_REQUEST_TIMEOUT' }));
    const fetch = createSupabaseAvailabilityGate(fetcher);
    await expect(fetch('https://database.example', { method: 'POST' })).rejects.toThrow('timed out');
    expect((await fetch('https://database.example')).headers.get('retry-after')).toBe('2');
    await vi.advanceTimersByTimeAsync(2000);
    await expect(fetch('https://database.example')).rejects.toThrow('timed out');
    expect((await fetch('https://database.example')).headers.get('retry-after')).toBe('4');
    expect(fetcher).toHaveBeenCalledTimes(2);
});
it('does not let an older successful request close a newer outage', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
        .mockResolvedValueOnce(new Response('', { status: 503 }));
    const fetch = createSupabaseAvailabilityGate(fetcher), older = fetch('https://database.example');
    await fetch('https://database.example'); finish(new Response('[]')); await older;
    expect((await fetch('https://database.example')).status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(2);
});
it('does not interpret a caller cancellation or invalid credentials as a database outage', async () => {
    const parent = new AbortController();
    const fetcher = vi.fn().mockImplementationOnce(async () => { parent.abort(); throw parent.signal.reason; })
        .mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(new Response('[]'));
    const fetch = createSupabaseAvailabilityGate(fetcher);
    await expect(fetch('https://database.example', { signal: parent.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect((await fetch('https://database.example')).status).toBe(401);
    expect((await fetch('https://database.example')).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(3);
});
