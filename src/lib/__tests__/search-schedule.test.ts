import { expect, it } from 'vitest';
import { createSearchSchedule } from '../search-schedule';
it('waits for typing only, while initial, filter and explicit refresh reads start immediately', () => {
    const delay = createSearchSchedule('');expect(delay('')).toBe(0);expect(delay('a')).toBe(250);expect(delay('ab')).toBe(250);expect(delay('ab')).toBe(0);
});
