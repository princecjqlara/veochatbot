import { afterEach, expect, it, vi } from 'vitest';
import { startAdaptivePolling } from '../adaptive-polling';
afterEach(() => { vi.useRealTimers(); });
it('waits for each request instead of overlapping slow polls', async () => {
    vi.useFakeTimers(); let finish!: () => void;
    const task = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
    const stop = startAdaptivePolling(task, { intervalMs: 1000, immediate: true });
    await vi.advanceTimersByTimeAsync(5000); expect(task).toHaveBeenCalledOnce();
    finish(); await vi.advanceTimersByTimeAsync(1000); expect(task).toHaveBeenCalledTimes(2);
    stop(); expect(vi.getTimerCount()).toBe(0);
});
it('backs off failures and restores the fast interval after recovery', async () => {
    vi.useFakeTimers(); const task = vi.fn().mockRejectedValueOnce(Error('unavailable')).mockRejectedValueOnce(Error('unavailable')).mockResolvedValue(undefined);
    const stop = startAdaptivePolling(task, { intervalMs: 1000, immediate: true });
    await vi.advanceTimersByTimeAsync(1999); expect(task).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(task).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000); expect(task).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000); expect(task).toHaveBeenCalledTimes(4);
    stop();
});
it('pauses hidden tabs, refreshes on return, and cancels when unmounted', async () => {
    vi.useFakeTimers(); const listeners = new Map<string, any>();
    const visibility = { hidden: true, addEventListener: vi.fn((key, handler) => listeners.set(key, handler)), removeEventListener: vi.fn() };
    const task = vi.fn(async (_signal: AbortSignal) => {});
    const stop = startAdaptivePolling(task, { intervalMs: 1000, immediate: true, visibility });
    await vi.advanceTimersByTimeAsync(10_000); expect(task).not.toHaveBeenCalled();
    visibility.hidden = false; listeners.get('visibilitychange')();
    await vi.advanceTimersByTimeAsync(0); expect(task).toHaveBeenCalledOnce();
    visibility.hidden = true; listeners.get('visibilitychange')();
    await vi.advanceTimersByTimeAsync(10_000); expect(task).toHaveBeenCalledOnce();
    stop(); expect(task.mock.calls[0][0].aborted).toBe(true); expect(visibility.removeEventListener).toHaveBeenCalledOnce();
});
