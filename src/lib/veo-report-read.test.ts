import { afterEach, expect, it, vi } from 'vitest';
import { readVeoReport } from './veo-report-read';
import { createSupabaseAvailabilityGate } from './supabase-availability';
afterEach(() => { vi.useRealTimers(); });
it('retries a transient gateway failure once and returns the complete successful report', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce({ error: { code: 'SUPABASE_UPSTREAM_502' } }).mockResolvedValueOnce({ data: { total: 23 } });
    const result = readVeoReport(read); await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toEqual({ data: { total: 23 } }); expect(read).toHaveBeenCalledTimes(2);
});
it('stops immediately on a current authorization or validation failure', async () => {
    for (const code of ['42501', '22023']) {
        const read = vi.fn().mockResolvedValue({ error: { code } });
        expect(await readVeoReport(read)).toEqual({ error: { code } }); expect(read).toHaveBeenCalledTimes(1);
    }
});
it('honors access revocation on the retry instead of continuing with an older scope', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce({ error: { code: 'SUPABASE_UPSTREAM_502' } }).mockResolvedValueOnce({ error: { code: '42501' } });
    const result = readVeoReport(read); await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toEqual({ error: { code: '42501' } }); expect(read).toHaveBeenCalledTimes(2);
});
it('bounds retries and reports persistent failures as unavailable instead of zero totals', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue({ error: { code: 'SUPABASE_UPSTREAM_502' } });
    const result = expect(readVeoReport(read)).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(2000); await result; expect(read).toHaveBeenCalledTimes(2);
});
it('cancels a stalled transport when the complete read budget expires', async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    const result = expect(readVeoReport(s => { signal = s; return new Promise(() => {}); }, 100)).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(100); await result; expect(signal?.aborted).toBe(true);
});
it.each([{code:'57014'},{code:'55P03'},{code:'53300'},{code:'PGRST003'},{ code: '', message: 'Error: Supabase request timed out' }, { code: 'SUPABASE_UPSTREAM_522' }])('does not repeat timeout or capacity errors while the database is saturated: %j', async error => {
    const read = vi.fn().mockResolvedValueOnce({ error }).mockResolvedValueOnce({ data: { total: 23 } });
    await expect(readVeoReport(read)).rejects.toMatchObject({code:'DATABASE_UNAVAILABLE'});
    expect(read).toHaveBeenCalledOnce();
});
it('waits for the recovery gate before retrying a failed read', async () => {
    vi.useFakeTimers();
    const upstream = vi.fn().mockResolvedValueOnce(Response.json({ code: 'SUPABASE_UPSTREAM_502' }, { status: 502 }))
        .mockResolvedValueOnce(Response.json({ total: 23 }));
    const fetch = createSupabaseAvailabilityGate(upstream);
    const result = readVeoReport(async () => {
        const response = await fetch('https://database.example');
        const body = await response.json();
        return response.ok ? { data: body } : { error: body };
    });
    await vi.advanceTimersByTimeAsync(1999);expect(upstream).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ data: { total: 23 } });expect(upstream).toHaveBeenCalledTimes(2);
});
it('normalizes exhausted transport failures and respects the total read budget', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValue(Object.assign(new Error('Supabase request timed out'), { code: 'SUPABASE_REQUEST_TIMEOUT' }));
    const result = expect(readVeoReport(read, 5000)).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    await result;
    expect(read).toHaveBeenCalledOnce();
});
it('does not start another long query after its first attempt deadline expires',async()=>{
    vi.useFakeTimers();const read=vi.fn(()=>new Promise(()=>{}));
    const result=expect(readVeoReport(read)).rejects.toMatchObject({code:'DATABASE_UNAVAILABLE'});
    await vi.advanceTimersByTimeAsync(18000);await result;expect(read).toHaveBeenCalledOnce();
});
it('keeps an already open circuit fail-fast without retrying every incoming read', async () => {
    const read = vi.fn().mockResolvedValue({ error: { code: 'SUPABASE_CIRCUIT_OPEN' } });
    expect(await readVeoReport(read)).toEqual({ error: { code: 'SUPABASE_CIRCUIT_OPEN' } });expect(read).toHaveBeenCalledOnce();
});
