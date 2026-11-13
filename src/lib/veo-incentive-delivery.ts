export async function queueIncentiveNotices(db: any) {
    const rows = await db.from('veo_incentive_notices').select('id').is('queued_at', null).lte('next_attempt_at', new Date().toISOString()).order('created_at').limit(10);
    if (rows.error) throw Error('Incentive queue unavailable');
    let queued = 0;
    for (const row of rows.data || []) {
        await db.from('veo_incentive_notices').update({ next_attempt_at: new Date(Date.now() + 300000).toISOString() }).eq('id', row.id);
        try {
            const target = new URL('/api/veo/handoff', process.env.VEO_JAUCIAN_URL);
            if (target.protocol !== 'https:' || !process.env.VEO_JAUCIAN_SECRET) continue;
            const r = await fetch(target, { method: 'POST', headers: { Authorization: `Bearer ${process.env.VEO_JAUCIAN_SECRET}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'incentive', notice_id: row.id }), signal: AbortSignal.timeout(10000) });
            const body = await r.json();
            if (r.ok && body.ok === true) {
                const saved = await db.from('veo_incentive_notices').update({ queued_at: new Date().toISOString() }).eq('id', row.id);
                if (!saved.error) queued++;
            }
        } catch { /* Persisted notice is retried on the next scheduled run. */ }
    }
    return { queued };
}
