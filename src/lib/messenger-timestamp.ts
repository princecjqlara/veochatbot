const EARLIEST = Date.parse('2000-01-01T00:00:00Z');
/** Webhook adapters may forward Unix seconds, milliseconds, or an ISO time. */
export function messengerTimestamp(value: unknown, now = Date.now()): number | null {
 if (typeof value !== 'number' && typeof value !== 'string') return null;
 const text = typeof value === 'string' ? value.trim() : '';
 if (typeof value === 'string' && !text) return null;
 const numeric = typeof value === 'number' ? value : /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : NaN;
 const parsed = Number.isFinite(numeric) ? numeric >= EARLIEST ? numeric : numeric * 1000
  : /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? Date.parse(text) : NaN;
 if (!Number.isFinite(parsed) || parsed < EARLIEST || parsed > now + 60_000) return null;
 return Math.trunc(parsed);
}
