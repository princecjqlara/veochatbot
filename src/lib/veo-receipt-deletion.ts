/** Deletion is persisted in the same transaction as the receipt tombstone.
 * Both interactive requests and the workspace worker can retry this outbox;
 * Jaucian deduplicates by submission and verifies the tombstone independently. */
export async function queueReceiptDeletions(db: any, submission?: string) {
    let queued = 0, retry = false;
    try {
        let query = db.from('veo_receipt_deletion_outbox').select('submission_id').is('queued_at', null).order('created_at').limit(10);
        if (submission) query = query.eq('submission_id', submission);
        const rows = await query;
        if (rows.error) return { queued, retry: true };
        for (const row of rows.data || []) {
            try {
                const target = new URL('/api/veo/handoff', process.env.VEO_JAUCIAN_URL);
                const secret = process.env.VEO_JAUCIAN_SECRET;
                if (target.protocol !== 'https:' || target.username || target.password || !secret) throw Error('Jaucian deletion is not configured');
                const result = await fetch(target, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'delete_receipt', submission_id: row.submission_id }), signal: AbortSignal.timeout(10000) });
                const body = await result.json();
                if (!result.ok || body.ok !== true || body.deletion_queued !== true) throw Error('Jaucian deletion queue unavailable');
                const saved = await db.from('veo_receipt_deletion_outbox').update({ queued_at: new Date().toISOString(), last_error: null }).eq('submission_id', row.submission_id);
                if (saved.error) throw Error('Deletion acknowledgment unavailable');
                queued++;
            } catch {
                retry = true;
                await db.from('veo_receipt_deletion_outbox').update({ last_error: 'Telegram removal pending; automatic retry scheduled' }).eq('submission_id', row.submission_id);
            }
        }
    } catch { retry = true; }
    return { queued, retry };
}
