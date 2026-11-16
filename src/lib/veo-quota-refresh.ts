/** Each worker commits independently. Stop starting work when the run's budget
 * is spent; expired leases let the next scheduled run resume fairly. */
export async function refreshQuotaSnapshots(db: {rpc: Function}, budgetMs = 90000, beforeBatch?: () => Promise<unknown>) {
    const deadline = Date.now() + budgetMs;
    let workers = 0, failed = 0, deferred = false;
    for (let batch = 0; batch < 25; batch++) {
        if (Date.now() >= deadline - 5000) { deferred = true;break; }
        if (beforeBatch) {
            try { await beforeBatch(); }
            catch { return {workers, failed, deferred: true, paused: true}; }
        }
        const claim = await db.rpc('veo_claim_quota_refresh', {p_limit: 4});
        if (claim.error || !Array.isArray(claim.data)) throw Error('Quota refresh coordination unavailable');
        if (!claim.data.length) return {workers, failed, deferred};
        for (const item of claim.data) {
            // One SQL request has a five-second server deadline.
            if (Date.now() >= deadline - 5000) { deferred = true;break; }
            const result = await db.rpc('veo_refresh_worker_quota', {p_user: item.user_id, p_lease: item.lease_token});
            if (result.error || !result.data) throw Error('Quota refresh will resume on the next scheduled run');
            if (result.data.ok === true) workers++;else failed++;
            if (result.data.overloaded) { deferred = true;break; }
        }
        if (deferred) break;
    }
    return {workers, failed, deferred: true};
}
