import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestDeadline } from '../request-deadline';
afterEach(() => { vi.useRealTimers(); });
describe('calendar read deadlines', () => {
 it('cancels an unresponsive transport with a recoverable database error', async () => {
  vi.useFakeTimers(); let signal: AbortSignal | undefined;
  const result = requestDeadline(s => { signal = s; return new Promise(() => {}); }, 1000);
  const check = expect(result).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
  await vi.advanceTimersByTimeAsync(1000); await check; expect(signal?.aborted).toBe(true);
 });
 it('retains parent cancellation and clears deadlines after success', async () => {
  vi.useFakeTimers(); const parent = new AbortController();
  const result = requestDeadline(() => new Promise(() => {}), 1000, parent.signal);
  const check = expect(result).rejects.toMatchObject({ name: 'AbortError' }); parent.abort(); await check;
  expect(vi.getTimerCount()).toBe(0);
  expect(await requestDeadline(async () => ({ total: 42 }), 1000)).toEqual({ total: 42 });
  expect(vi.getTimerCount()).toBe(0);
 });
});
