import { expect, it, vi } from 'vitest';
import { createCalendarCache } from '../veo-calendar-cache';
it('coalesces overlapping reads, expires results and separates authorization scopes', async () => {
    let clock = 0, finish!: (v: string) => void;
    const cache = createCalendarCache<string>(30, 2, () => clock);
    const loader = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const one = cache('owner:pages', loader), duplicate = cache('owner:pages', loader, true);
    expect(loader).toHaveBeenCalledTimes(1); finish('result'); expect(await one).toBe('result'); expect(await duplicate).toBe('result');
    expect(await cache('owner:pages', async () => 'wrong')).toBe('result');
    expect(await cache('leader:pages', async () => 'other scope')).toBe('other scope');
    clock = 31; expect(await cache('owner:pages', async () => 'fresh')).toBe('fresh');
    expect(await cache('owner:pages', async () => 'refresh', true)).toBe('refresh');
});
it('does not cache failed or oversized results', async () => {
    const cache = createCalendarCache<string>(30000), load = vi.fn(async () => 'x'.repeat(2_000_001));
    await expect(cache('failed', async () => { throw Error('outage'); })).rejects.toThrow('outage');
    expect(await cache('failed', async () => 'recovered')).toBe('recovered');
    await cache('large', load); await cache('large', load); expect(load).toHaveBeenCalledTimes(2);
});
