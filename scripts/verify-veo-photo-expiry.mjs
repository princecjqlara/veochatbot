// A private one-pixel fixture exercises scheduled expiry without creating a sale or Telegram post.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const bucket = 'veo-conversation-submissions', probeFile = '.vercel/workspace-photo-expiry.json';
if (process.argv.includes('--seed')) {
    const receipt = JSON.parse(fs.readFileSync('.vercel/workspace-launch-receipt.json', 'utf8'));
    const objectPath = `${receipt.id}/${receipt.owner}/verification-${randomUUID()}.png`;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=', 'base64');
    const upload = await db.storage.from(bucket).upload(objectPath, png, { contentType: 'image/png', upsert: false });
    assert.ifError(upload.error);
    try {
        const row = await db.from('veo_photo_objects').insert({ object_path: objectPath, expires_at: new Date(Date.now() - 1000).toISOString() });
        assert.ifError(row.error);
        const publicRead = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${bucket}/${objectPath}`);
        assert.equal(publicRead.ok, false, 'The private test photo must reject anonymous access');
        fs.writeFileSync(probeFile, JSON.stringify({ object_path: objectPath, seeded_at: new Date().toISOString(), anonymous_access_blocked: true }, null, 2));
        console.log(JSON.stringify({ seeded: true, anonymous_access_blocked: true, awaiting_normal_scheduler: true, orders_created: 0, telegram_messages_sent: 0 }));
    } catch (error) { await db.storage.from(bucket).remove([objectPath]); throw error; }
} else if (process.argv.includes('--check')) {
    const probe = JSON.parse(fs.readFileSync(probeFile, 'utf8'));
    assert(probe.object_path.includes('/verification-'));
    const row = await db.from('veo_photo_objects').select('deleted_at').eq('object_path', probe.object_path).single();
    assert.ifError(row.error);
    if (!row.data.deleted_at) { console.log(JSON.stringify({ pending: true, awaiting_normal_scheduler: true })); process.exitCode = 2; }
    else {
        const file = await db.storage.from(bucket).download(probe.object_path);
        assert(file.error && !file.data, 'Expired object must be deleted');
        const removed = await db.from('veo_photo_objects').delete().eq('object_path', probe.object_path);
        assert.ifError(removed.error);
        Object.assign(probe, { passed: true, deleted_at: row.data.deleted_at, fixture_metadata_removed: true, orders_created: 0, telegram_messages_sent: 0 });
        fs.writeFileSync(probeFile, JSON.stringify(probe, null, 2));
        console.log(JSON.stringify({ passed: true, private_access_verified: true, scheduled_expiry_deletion_verified: true, fixture_removed: true, orders_created: 0, telegram_messages_sent: 0 }));
    }
} else throw new Error('Choose --seed or --check');
