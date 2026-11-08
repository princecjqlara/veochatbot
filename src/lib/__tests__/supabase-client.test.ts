import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getSupabaseAdmin } from '../supabase';

beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://vhtbmdizugnxkgocmruq.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

it('cancels all work on the request client without affecting other requests or replaying writes', async () => {
    const fetch = vi.fn(async () => new Response('[]', { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const parent = new AbortController();
    const scoped = getSupabaseAdmin(parent.signal);
    expect((await scoped.from('veo_tenants').select('id')).error).toBeNull();
    parent.abort();
    expect((await scoped.rpc('veo_apply_telegram_observations', {})).error).not.toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    expect((await getSupabaseAdmin().from('veo_tenants').select('id')).error).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
});

it('respects an individual query cancellation as well as the request deadline', async () => {
    vi.useFakeTimers();
    let transport: AbortSignal | undefined;
    const fetch = vi.fn((_input, init) => new Promise((_resolve, reject) => {
        transport = init.signal;
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetch);
    const request = new AbortController(), query = new AbortController();
    const pending = Promise.resolve(getSupabaseAdmin(request.signal).from('veo_tenants').select('id').abortSignal(query.signal));
    await vi.advanceTimersByTimeAsync(0);
    query.abort();
    expect((await pending).error).not.toBeNull();
    expect(transport?.aborted).toBe(true);
    expect(request.signal.aborted).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
});
