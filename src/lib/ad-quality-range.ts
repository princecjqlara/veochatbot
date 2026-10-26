const DAY = 86_400_000, OFFSET = 8 * 3_600_000;
function midnight(value: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Use YYYY-MM-DD dates');
    const utc = Date.parse(value + 'T00:00:00Z');
    if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== value) throw new Error('Invalid calendar date');
    return utc - OFFSET;
}
export function adQualityRange(q: URLSearchParams, now = new Date()) {
    const preset = q.get('range') || 'today', current = now.getTime();
    const today = new Date(current + OFFSET).toISOString().slice(0, 10), start = midnight(today);
    let from: number | null, to = current;
    if (preset === 'all') from = null;
    else if (preset === 'today') from = start;
    else if (preset === '7' || preset === '30') from = start - (Number(preset) - 1) * DAY;
    else if (preset === 'custom') {
        from = midnight(q.get('from') || ''); const end = midnight(q.get('to') || '');
        if (from > end) throw new Error('Start date must be on or before end date');
        if (from > current) throw new Error('The date range starts in the future');
        to = Math.min(current, end + DAY);
    } else throw new Error('Choose today, 7, 30, all, or custom');
    return { preset, from: from == null ? null : new Date(from).toISOString(), to: new Date(to).toISOString(), timezone: 'Asia/Manila', generated_at: now.toISOString() };
}
