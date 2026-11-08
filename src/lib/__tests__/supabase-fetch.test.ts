import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { supabaseFetch } from '../supabase-fetch';

const url = 'https://database.example/rest/v1/rows';
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('bounded Supabase transport', () => {
    it('preserves JSON responses and clears the timer after consuming the body', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[{"id":1}]', { headers: { 'content-type': 'application/json' } })));
        const response = await supabaseFetch(url);
        expect(await response.json()).toEqual([{ id: 1 }]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('times out a stalled body even after successful response headers', async () => {
        const cancel = vi.fn();
        let signal: AbortSignal | undefined;
        vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
            signal = init.signal;
            return new Response(new ReadableStream({ cancel }));
        }));
        const response = await supabaseFetch(url, { method: 'POST' });
        const body = response.json();
        const check = expect(body).rejects.toMatchObject({ code: 'SUPABASE_REQUEST_TIMEOUT' });
        await vi.advanceTimersByTimeAsync(10_000);
        await check;
        expect(signal?.aborted).toBe(true);
        expect(cancel).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['POST', 'PATCH', 'DELETE'])('never replays a timed-out %s', async method => {
        const fetch = vi.fn((_input, init) => new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        }));
        vi.stubGlobal('fetch', fetch);
        const pending = supabaseFetch(url, { method });
        const check = expect(pending).rejects.toMatchObject({ code: 'SUPABASE_REQUEST_TIMEOUT' });
        await vi.advanceTimersByTimeAsync(10_000);
        await check;
        expect(fetch).toHaveBeenCalledOnce();
    });

    it('retries transient reads, cancelling each discarded upstream response', async () => {
        const cancel = vi.fn();
        const fetch = vi.fn()
            .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 522 }))
            .mockResolvedValueOnce(new Response('[]'));
        vi.stubGlobal('fetch', fetch);
        const pending = supabaseFetch(url);
        await vi.advanceTimersByTimeAsync(250);
        expect(await (await pending).json()).toEqual([]);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(cancel).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('normalizes a Cloudflare error without replaying the RPC or leaking HTML', async () => {
        const fetch = vi.fn().mockResolvedValue(new Response('<html>upstream failure</html>', {
            status: 522, headers: { 'content-type': 'text/html', 'cf-ray': 'example-ray' }
        }));
        vi.stubGlobal('fetch', fetch);
        const response = await supabaseFetch(url, { method: 'POST' });
        expect(response.status).toBe(522);
        expect(response.headers.get('x-supabase-upstream-ray')).toBe('example-ray');
        expect(await response.json()).toMatchObject({ code: 'SUPABASE_UPSTREAM_522' });
        expect(fetch).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('honors a Request signal and stops read retries when its parent cancels', async () => {
        const parent = new AbortController();
        const fetch = vi.fn((_input, init) => new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        }));
        vi.stubGlobal('fetch', fetch);
        const pending = supabaseFetch(new Request(url, { signal: parent.signal }));
        const check = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        parent.abort();
        await check;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(fetch).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects an already cancelled request before making a network call', async () => {
        const parent = new AbortController(); parent.abort();
        const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
        await expect(supabaseFetch(url, { signal: parent.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(fetch).not.toHaveBeenCalled();
    });
});
