import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSupabaseAvailabilityGate } from '../supabase-availability';
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
it('sheds new traffic after an internal request deadline even when its signal is aborted',async()=>{
    const controller=new AbortController(),timeout=Object.assign(Error('Database deadline'),{code:'DATABASE_UNAVAILABLE'});
    const upstream=vi.fn(async()=>{controller.abort(timeout);throw timeout;});const fetch=createSupabaseAvailabilityGate(upstream);
    await expect(fetch('https://database.example',{signal:controller.signal})).rejects.toBe(timeout);
    const later=await Promise.all(Array.from({length:30},()=>fetch('https://database.example')));
    expect(later.every(r=>r.status===503)).toBe(true);expect(upstream).toHaveBeenCalledOnce();
});
it('opens the circuit when a response body fails after successful headers',async()=>{
    let fail!:(e:Error)=>void;const upstream=vi.fn(async()=>new Response(new ReadableStream({start(c){fail=e=>c.error(e);}})));
    const fetch=createSupabaseAvailabilityGate(upstream),response=await fetch('https://database.example');
    const body=expect(response.text()).rejects.toMatchObject({code:'SUPABASE_REQUEST_TIMEOUT'});
    fail(Object.assign(Error('Body timed out'),{code:'SUPABASE_REQUEST_TIMEOUT'}));await body;
    expect((await fetch('https://database.example')).status).toBe(503);expect(upstream).toHaveBeenCalledOnce();
});
it('ignores body failures belonging to older recovered requests',async()=>{
    let oldFail!:(e:Error)=>void;
    const stream=(save:(fail:(e:Error)=>void)=>void)=>new Response(new ReadableStream({start(c){save(e=>c.error(e));}}));
    const upstream=vi.fn().mockResolvedValueOnce(stream(f=>{oldFail=f;})).mockResolvedValueOnce(new Response('',{status:503})).mockImplementation(async()=>new Response('[]'));
    const fetch=createSupabaseAvailabilityGate(upstream),old=await fetch('https://database.example');
    const oldBody=old.text().catch(e=>e);await fetch('https://database.example');await vi.advanceTimersByTimeAsync(2000);
    const probe=await fetch('https://database.example');await probe.text();
    const timeout=Object.assign(Error('timeout'),{code:'SUPABASE_REQUEST_TIMEOUT'});
    oldFail(timeout);await oldBody;expect((await fetch('https://database.example')).status).toBe(200);
});
it('keeps a recovery probe exclusive until its complete body is verified',async()=>{
    let fail!:(e:Error)=>void;
    const upstream=vi.fn().mockResolvedValueOnce(new Response('',{status:503})).mockImplementationOnce(async()=>new Response(new ReadableStream({start(c){fail=e=>c.error(e);}})));
    const fetch=createSupabaseAvailabilityGate(upstream);await fetch('https://database.example');await vi.advanceTimersByTimeAsync(2000);
    const probe=await fetch('https://database.example'),body=probe.text().catch(e=>e);
    expect((await fetch('https://database.example')).status).toBe(503);expect(upstream).toHaveBeenCalledTimes(2);
    fail(Object.assign(Error('Body timeout'),{code:'SUPABASE_REQUEST_TIMEOUT'}));await body;
    expect((await fetch('https://database.example')).status).toBe(503);
});
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
    resolveProbe(new Response('[]')); await (await probe).text();
    const recovered=await fetch('https://database.example');expect(recovered.status).toBe(200);await recovered.text();
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
it.each(['response', 'timeout'])('does not reopen a recovered connection for an older %s failure', async kind => {
    let finish!: (response: Response) => void, fail!: (error: Error) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve, reject) => { finish = resolve; fail = reject; }))
        .mockResolvedValueOnce(new Response('', { status: 503 })).mockImplementation(async () => new Response('[]'));
    const fetch = createSupabaseAvailabilityGate(fetcher), older = fetch('https://database.example');
    const oldResult = older.catch(error => error);
    await fetch('https://database.example');await vi.advanceTimersByTimeAsync(2000);
    const recovered = await fetch('https://database.example');expect(recovered.status).toBe(200);await recovered.text();
    if (kind === 'response') finish(new Response('', { status: 503 }));
    else fail(Object.assign(new Error('Supabase request timed out'), { code: 'SUPABASE_REQUEST_TIMEOUT' }));
    await oldResult;
    expect((await fetch('https://database.example')).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(4);
});
it('backs off once for a failed batch rather than extending the outage for every delayed response', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
        .mockResolvedValueOnce(new Response('', { status: 503 })).mockImplementation(async () => new Response('[]'));
    const fetch = createSupabaseAvailabilityGate(fetcher), older = fetch('https://database.example');
    await fetch('https://database.example');await vi.advanceTimersByTimeAsync(1500);
    finish(new Response('', { status: 503 }));await older;
    await vi.advanceTimersByTimeAsync(500);
    expect((await fetch('https://database.example')).status).toBe(200);
});
