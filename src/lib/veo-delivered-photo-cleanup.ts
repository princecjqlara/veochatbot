const bucket = 'veo-conversation-submissions';
/** Remove the entire evidence bundle only after a persisted Telegram delivery.
 * Query the photos themselves so older partially cleaned submissions are also
 * found. Storage removal precedes the checkpoint; either failure can retry.
 */
export async function cleanupDeliveredReceiptPhotos(db: any, submission?: string) {
    let query = db.from('veo_deal_review_photos').select(
        'object_path,object:veo_photo_objects!inner(deleted_at),review:veo_deal_reviews!veo_deal_review_photos_review_id_fkey!inner(status,delivery_submission,delivery:veo_submissions!veo_deal_reviews_delivery_submission_fkey!inner(id,status,delivered_at))'
    ).is('object.deleted_at', null).eq('review.status', 'approved').eq('review.delivery.status', 'delivered')
        .not('review.delivery.delivered_at', 'is', null).limit(90);
    if (submission) query = query.eq('review.delivery_submission', submission);
    const result = await query;
    if (result.error || !Array.isArray(result.data)) throw Error('Delivered receipt photo scan unavailable');
    for (const row of result.data) {
        if (typeof row.object_path !== 'string' || !row.object_path || row.object?.deleted_at !== null ||
            row.review?.status !== 'approved' || row.review.delivery?.status !== 'delivered' || !row.review.delivery.delivered_at ||
            row.review.delivery_submission !== row.review.delivery.id || submission && row.review.delivery.id !== submission) {
            throw Error('Delivered receipt photo cleanup eligibility could not be confirmed');
        }
    }
    const paths = [...new Set<string>(result.data.map((row: any) => row.object_path))];
    if (!paths.length) return { removed: 0 };
    const removed = await db.storage.from(bucket).remove(paths);
    if (removed.error) throw Error('Delivered receipt photo deletion pending');
    const saved = await db.from('veo_photo_objects').update({ deleted_at: new Date().toISOString() }).in('object_path', paths);
    if (saved.error) throw Error('Delivered receipt photo deletion checkpoint pending');
    return { removed: paths.length };
}
