import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';
import Chart from './VeoAdPerformanceChart';
let view: ReactTestRenderer;
afterEach(async () => { if (view) await act(async () => view.unmount()); });
it('shows real zeros while leaving missing delivery dates as gaps and offers exact day inspection', async () => {
    const rows = [{ day: '2026-11-01', impressions: 0 }, { day: '2026-11-02', impressions: null }, { day: '2026-11-03', impressions: 100 }];
    await act(async () => { view = create(createElement(Chart, { rows, metricKey: 'impressions', currency: 'PHP' })); });
    expect(view.root.findAllByType('path')).toHaveLength(2); expect(view.root.findAllByType('circle')).toHaveLength(2);
    expect(view.root.findByType('span').children.join('')).toBe('2 of 3 days available');
    await act(async () => view.root.findByType('select').props.onChange({ target: { value: '2026-11-02' } }));
    expect(view.root.findByProps({ 'aria-live': 'polite' }).findByType('strong').children).toEqual(['Unavailable']);
    await act(async () => view.root.findByType('select').props.onChange({ target: { value: '2026-11-01' } }));
    expect(view.root.findByProps({ 'aria-live': 'polite' }).findByType('strong').children).toEqual(['0']);
});
it('plots losses below zero, switches currency and shows ratios with their own units', async () => {
    const rows = [{ day: '2026-11-01', finance: [{ currency: 'PHP', net_minor: -1000, gross_roas: 2 }, { currency: 'USD', net_minor: 500 }] }];
    await act(async () => { view = create(createElement(Chart, { rows, metricKey: 'net_minor', currency: 'PHP' })); });
    const point = view.root.findByType('circle'); const zeroLine = view.root.findAllByType('line').at(-1)!;
    expect(point.props.cy).toBeGreaterThan(zeroLine.props.y1); expect(JSON.stringify(view.toJSON())).not.toMatch(/NaN|Infinity/);
    await act(async () => view.update(createElement(Chart, { rows, metricKey: 'net_minor', currency: 'USD' })));
    expect(view.root.findByProps({ 'aria-live': 'polite' }).findByType('strong').children.join('')).toContain('5.00');
    await act(async () => view.update(createElement(Chart, { rows, metricKey: 'gross_roas', currency: 'PHP' })));
    expect(view.root.findByProps({ 'aria-live': 'polite' }).findByType('strong').children).toEqual(['2.00×']);
});
