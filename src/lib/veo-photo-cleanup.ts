/** Delete one bounded storage batch, then checkpoint it with bounded writes. */
export async function cleanupWorkspacePhotos(db: any) {
    const at = new Date().toISOString();
    const cleanup = await db.from('veo_submissions').select('id,object_path,expires_at,status').is('deleted_at', null)
        .or(`status.eq.delivered,expires_at.lte.${at}`).limit(30);
    if (cleanup.error) throw new Error('Photo cleanup unavailable');
    const rows: Array<{ id: string; object_path: string; status: string }> = cleanup.data || [];
    if (rows.length) {
        const paths = [...new Set(rows.map(row => row.object_path))];
        const removed = await db.storage.from('veo-conversation-submissions').remove(paths);
        if (removed.error) throw new Error('Temporary photo deletion pending');
        const saved = await db.from('veo_photo_objects').update({ deleted_at: at }).in('object_path', paths);
        if (saved.error) throw new Error('Photo deletion metadata unavailable');
        for (const delivered of [true, false]) {
            const ids = rows.filter(row => (row.status === 'delivered') === delivered).map(row => row.id);
            if (!ids.length) continue;
            const checkpoint = await db.from('veo_submissions').update({ deleted_at: at,
                ...(delivered ? {} : { status: 'expired', last_error: 'Photo expired; re-upload required' }) }).in('id', ids);
            if (checkpoint.error) throw new Error('Photo deletion checkpoint unavailable');
        }
    }
    const orphans = await db.from('veo_photo_objects').select('object_path').is('deleted_at', null).lte('expires_at', at).limit(30);
    if (orphans.error) throw new Error('Temporary photo expiry scan unavailable');
    if (orphans.data?.length) {
        const paths = [...new Set(orphans.data.map((row: any) => row.object_path))];
        const removed = await db.storage.from('veo-conversation-submissions').remove(paths);
        if (removed.error) throw new Error('Expired photo deletion pending');
        const saved = await db.from('veo_photo_objects').update({ deleted_at: at }).in('object_path', paths);
        if (saved.error) throw new Error('Expired photo checkpoint unavailable');
    }
}
