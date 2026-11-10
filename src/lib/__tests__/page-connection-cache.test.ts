import { afterEach, expect, it, vi } from 'vitest';
import { PageConnectionCache } from '../page-connection-cache';
afterEach(() => { vi.useRealTimers(); });
const valid = { tokenStatus: 'valid', webhookStatus: 'ready' } as const;
it('shares concurrent probes and briefly reuses health without storing a raw token', async () => {
    const cache = new PageConnectionCache(), read = vi.fn(async () => valid), key = ['page', 'secret-token', 'app'];
    expect(await Promise.all([cache.read(key, read), cache.read(key, read)])).toEqual([valid, valid]);
    await cache.read(key, read);expect(read).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(cache)).not.toContain('secret-token');
});
it('rechecks after expiry, token/app changes and an explicit refresh', async () => {
    vi.useFakeTimers();const cache = new PageConnectionCache(), read = vi.fn(async () => valid);
    await cache.read(['page', 'old', 'app'], read);
    await cache.read(['page', 'new', 'app'], read);
    await cache.read(['page', 'new', 'new-app'], read);
    await cache.read(['page', 'old', 'app'], read, true);
    await vi.advanceTimersByTimeAsync(30001);await cache.read(['page', 'old', 'app'], read);
    expect(read).toHaveBeenCalledTimes(5);
});
it('does not retain failed probes or turn uncertain health into a confirmed connection', async () => {
    vi.useFakeTimers();const cache = new PageConnectionCache(), read = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue({ tokenStatus: 'unknown', webhookStatus: 'unknown' });
    await expect(cache.read(['page'], read)).rejects.toThrow('offline');
    expect((await cache.read(['page'], read)).tokenStatus).toBe('unknown');
    await vi.advanceTimersByTimeAsync(3001);await cache.read(['page'], read);expect(read).toHaveBeenCalledTimes(3);
});
