'use client';
import { useEffect, useRef } from 'react';

export const HOURLY_REPORT_REFRESH_MS = 60 * 60 * 1000;

/** Refresh a visible report hourly. Returning to a tab only refreshes it when
 * the hour is due, and a slow request never overlaps another automatic read. */
export function useHourlyReportRefresh(refresh: () => unknown | Promise<unknown>, enabled = true, scope = '') {
    const latest = useRef(refresh); latest.current = refresh;
    useEffect(() => {
        if (!enabled || typeof document === 'undefined' || typeof window === 'undefined') return;
        let checked = Date.now(), running = false, disposed = false;
        const tick = async () => {
            if (disposed || document.hidden || running || Date.now() - checked < HOURLY_REPORT_REFRESH_MS) return;
            checked = Date.now(); running = true;
            try { await latest.current(); }
            catch { /* The report owns its error state; retry on the next hour. */ }
            finally { running = false; }
        };
        const timer = setInterval(() => void tick(), HOURLY_REPORT_REFRESH_MS);
        document.addEventListener('visibilitychange', tick);
        window.addEventListener('focus', tick); window.addEventListener('online', tick);
        return () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', tick); window.removeEventListener('focus', tick); window.removeEventListener('online', tick); };
    }, [enabled, scope]);
}
