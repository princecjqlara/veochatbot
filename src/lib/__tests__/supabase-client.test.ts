import { afterEach, beforeEach, expect, it, vi } from 'vitest';
let getSupabaseAdmin: typeof import('../supabase')['getSupabaseAdmin'];

beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://vhtbmdizugnxkgocmruq.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
    vi.stubEnv('VEO_PAGE_SCOPE_ENFORCED', 'false');
    ({getSupabaseAdmin} = await import('../supabase'));
});

it('keeps live permission reads available when a background query opens the ordinary circuit',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({code:'57014',message:'Statement timed out'},{status:503})).mockResolvedValueOnce(Response.json({user_id:'member',role:'member',launch_at:'2026-11-05'}));
    vi.stubGlobal('fetch',fetcher);
    expect((await getSupabaseAdmin().rpc('veo_maintenance')).error).not.toBeNull();
    expect((await getSupabaseAdmin().rpc('veo_maintenance')).error?.code).toBe('SUPABASE_CIRCUIT_OPEN');
    const access=getSupabaseAdmin(undefined,'access');expect(access).toBe(getSupabaseAdmin(undefined,'access'));
    expect((await access.rpc('veo_access_context',{p_actor:'member'})).data).toMatchObject({role:'member'});
    expect(fetcher).toHaveBeenCalledTimes(2);
});
it('still fails closed when the permission database itself is unavailable',async()=>{
    const fetcher=vi.fn(async()=>Response.json({code:'PGRST002',message:'Database unavailable'},{status:503}));vi.stubGlobal('fetch',fetcher);
    const access=getSupabaseAdmin(undefined,'access');expect((await access.rpc('veo_access_context',{p_actor:'member'})).error).not.toBeNull();
    expect((await access.rpc('veo_access_context',{p_actor:'member'})).error?.code).toBe('SUPABASE_CIRCUIT_OPEN');expect(fetcher).toHaveBeenCalledOnce();
});
it('keeps basic workspace reads available after a heavy query opens its own circuit',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({code:'57014',message:'Statement timed out'},{status:503}))
        .mockResolvedValueOnce(Response.json({accounts:[]}));
    vi.stubGlobal('fetch',fetcher);
    expect((await getSupabaseAdmin().rpc('veo_maintenance')).error).not.toBeNull();
    expect((await getSupabaseAdmin().rpc('veo_maintenance')).error?.code).toBe('SUPABASE_CIRCUIT_OPEN');
    const interactive=getSupabaseAdmin(undefined,'interactive');expect(interactive).toBe(getSupabaseAdmin(undefined,'interactive'));
    expect((await interactive.rpc('veo_account_directory')).data).toEqual({accounts:[]});
    expect(fetcher).toHaveBeenCalledTimes(2);
});
it('gates an actual interactive database outage without blocking an independent healthy worker',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({code:'PGRST002',message:'Database unavailable'},{status:503}))
        .mockResolvedValueOnce(Response.json({ok:true}));
    vi.stubGlobal('fetch',fetcher);
    const interactive=getSupabaseAdmin(undefined,'interactive');
    expect((await interactive.rpc('veo_account_directory')).error).not.toBeNull();
    expect((await interactive.rpc('veo_account_directory')).error?.code).toBe('SUPABASE_CIRCUIT_OPEN');
    expect((await getSupabaseAdmin().rpc('veo_maintenance')).data).toEqual({ok:true});
    expect(fetcher).toHaveBeenCalledTimes(2);
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
