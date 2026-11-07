import { afterEach, expect, it, vi } from 'vitest';
import { readVeoReport } from './veo-report-read';
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
