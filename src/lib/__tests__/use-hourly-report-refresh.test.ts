import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { HOURLY_REPORT_REFRESH_MS, useHourlyReportRefresh } from '../use-hourly-report-refresh';
let view: ReactTestRenderer;
function Report({ refresh, enabled = true, scope = '' }: { refresh: () => unknown; enabled?: boolean; scope?: string }) { useHourlyReportRefresh(refresh, enabled, scope); return null; }
function browser() { const page = Object.assign(new EventTarget(), { hidden: false }); const tab = new EventTarget(); vi.stubGlobal('document', page); vi.stubGlobal('window', tab); return { page, tab }; }
afterEach(async () => { if (view) await act(async () => view.unmount()); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('makes no automatic request during the first 59 minutes, including repeated focus/online events', async () => {
    vi.useFakeTimers(); const { tab } = browser(), refresh = vi.fn();
    await act(async () => { view = create(createElement(Report, { refresh })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(HOURLY_REPORT_REFRESH_MS - 1); tab.dispatchEvent(new Event('focus')); tab.dispatchEvent(new Event('online')); });
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { tab.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(15000); }); expect(refresh).toHaveBeenCalledTimes(1);
});
it('waits while hidden and catches up once when the tab becomes visible after an hour', async () => {
    vi.useFakeTimers(); const { page, tab } = browser(), refresh = vi.fn(); page.hidden = true;
    await act(async () => { view = create(createElement(Report, { refresh })); await vi.advanceTimersByTimeAsync(HOURLY_REPORT_REFRESH_MS); }); expect(refresh).not.toHaveBeenCalled();
    page.hidden = false; await act(async () => { page.dispatchEvent(new Event('visibilitychange')); tab.dispatchEvent(new Event('focus')); }); expect(refresh).toHaveBeenCalledTimes(1);
});
it('does not overlap slow reads and stops automatic requests when disabled or unmounted', async () => {
    vi.useFakeTimers(); browser(); let finish!: () => void; const refresh = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    await act(async () => { view = create(createElement(Report, { refresh })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(HOURLY_REPORT_REFRESH_MS * 2); }); expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); view.update(createElement(Report, { refresh, enabled: false })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(HOURLY_REPORT_REFRESH_MS * 2); }); expect(refresh).toHaveBeenCalledTimes(1);
});
