import { expect, it } from 'vitest';
import { dailyDeliveryMetrics } from '../ad-daily-spend';
it('keeps absent or malformed Meta frequency unavailable instead of presenting a false zero', () => {
    for (const frequency of [null, undefined, '', ' ', true, false, '-1', 'NaN', Infinity]) expect(dailyDeliveryMetrics({ frequency }).frequency).toBeNull();
    expect(dailyDeliveryMetrics({ frequency: '0' }).frequency).toBe(0);
    expect(dailyDeliveryMetrics({ frequency: '2.75' }).frequency).toBe(2.75);
});
