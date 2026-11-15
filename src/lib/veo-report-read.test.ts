import { afterEach, expect, it, vi } from 'vitest';
import { readVeoReport } from './veo-report-read';
import { createSupabaseAvailabilityGate } from './supabase-availability';
afterEach(() => { vi.useRealTimers(); });
it('retries a transient read timeout and returns the complete successful report', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce({ error: { code: '57014' } }).mockResolvedValueOnce({ data: { total: 23 } });
    const result = readVeoReport(read); await vi.advanceTimersByTimeAsync(500);
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
    const read = vi.fn().mockResolvedValueOnce({ error: { code: '57014' } }).mockResolvedValueOnce({ error: { code: '42501' } });
    const result = readVeoReport(read); await vi.advanceTimersByTimeAsync(500);
    expect(await result).toEqual({ error: { code: '42501' } }); expect(read).toHaveBeenCalledTimes(2);
});
it('bounds retries and reports persistent failures as unavailable instead of zero totals', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue({ error: { code: '57014' } });
    const result = expect(readVeoReport(read)).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(2000); await result; expect(read).toHaveBeenCalledTimes(3);
});
it('cancels a stalled transport when the complete read budget expires', async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    const result = expect(readVeoReport(s => { signal = s; return new Promise(() => {}); }, 100)).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(100); await result; expect(signal?.aborted).toBe(true);
});
it.each([{ code: '', message: 'Error: Supabase request timed out' }, { code: 'SUPABASE_UPSTREAM_522' }])('recovers an SDK transport error returned as a result: %j', async error => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce({ error }).mockResolvedValueOnce({ data: { total: 23 } });
    const result = readVeoReport(read);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toEqual({ data: { total: 23 } });
    expect(read).toHaveBeenCalledTimes(2);
});
it('waits for the recovery gate before retrying a failed read', async () => {
    vi.useFakeTimers();
    const upstream = vi.fn().mockResolvedValueOnce(Response.json({ code: 'SUPABASE_UPSTREAM_522' }, { status: 522 }))
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
    await vi.advanceTimersByTimeAsync(2000);await result;
    expect(read).toHaveBeenCalledTimes(2);
});
it('keeps an already open circuit fail-fast without retrying every incoming read', async () => {
    const read = vi.fn().mockResolvedValue({ error: { code: 'SUPABASE_CIRCUIT_OPEN' } });
    expect(await readVeoReport(read)).toEqual({ error: { code: 'SUPABASE_CIRCUIT_OPEN' } });expect(read).toHaveBeenCalledOnce();
});
