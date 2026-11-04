// Store only per-contact conversation metrics. Raw history remains in the
// verified local archive and is never inserted into Postgres.
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import pg from 'pg';
import { assertProjectCredentials, VEO_TARGET_PROJECT, digest } from './lib/database-migration-safety.mjs';

const apply = process.argv.includes('--apply');
if (!apply && !process.argv.includes('--preflight')) throw Error('Choose --preflight or --apply');
const { parse } = createRequire(import.meta.url)('dotenv');
const env = parse(fs.readFileSync('.env.local', 'utf8'));
const { connectionString } = assertProjectCredentials(env, VEO_TARGET_PROJECT);
const dir = path.resolve('.vercel/veo-backlog');
const allowed = new Set(JSON.parse(fs.readFileSync('src/config/veo-pages.json', 'utf8')).map(page => page.facebook_page_id));
const baseRows = fs.readFileSync(path.join(dir, 'prepared-manifest.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const latestByIdentity = new Map(baseRows.map(row => [`${row.page_id}:${row.psid}`, row]));
for (const name of fs.readdirSync(path.join(dir, 'refreshed')).filter(value => value.endsWith('.profile.json.gz'))) {
    const file = path.join(dir, 'refreshed', name), compressed = fs.readFileSync(file);
    const artifact = JSON.parse(gunzipSync(compressed).toString('utf8'));
    if (!allowed.has(artifact.facebook_page_id)) continue;
    const key = `${artifact.page_id}:${artifact.psid}`, previous = latestByIdentity.get(key);
    if (!previous || Date.parse(artifact.source_cutoff_at) > Date.parse(previous.source_cutoff_at)) latestByIdentity.set(key, {
        page_id: artifact.page_id, psid: artifact.psid, facebook_page_id: artifact.facebook_page_id,
        source_sha256: artifact.source_sha256, source_cutoff_at: artifact.source_cutoff_at,
        artifact: path.relative(process.cwd(), file), artifact_sha256: digest(compressed), verified: true
    });
}
const records = [...latestByIdentity.values()];
assert(records.every(row => allowed.has(row.facebook_page_id) && row.verified !== false), 'Manifest contains an unapproved Page');
const bundle = path.join(dir, 'analysis-runtime.cjs');
const { verifyBacklogArtifact } = createRequire(import.meta.url)(bundle);
const db = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 25000, query_timeout: 120000 });
const batchSize = 250, report = { target_project: VEO_TARGET_PROJECT, applied: apply, sources: records.length, matched: 0, stored: 0,
    messages: 0, attachments: 0, images: 0, skipped_newer: 0, already_current: 0, errors: [] };
try {
    await db.connect();
    if (apply) {
        await db.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE');
        const mode = (await db.query("SELECT current_setting('transaction_read_only') AS read_only")).rows[0].read_only;
        assert(mode === 'off', 'Database is still read-only; compact metric publication stopped before writing');
    }
    const contacts = (await db.query(`SELECT c.id,c.page_id,c.psid,p.fb_page_id FROM public.contacts c JOIN public.pages p ON p.id=c.page_id WHERE p.fb_page_id=ANY($1::text[])`, [[...allowed]])).rows;
    const contactByIdentity = new Map(contacts.map(contact => [`${contact.page_id}:${contact.psid}`, contact]));
    const snapshots = (await db.query(`SELECT DISTINCT ON(contact_id) contact_id,page_id,source_cutoff_at FROM public.contact_profile_snapshots WHERE page_id IN (SELECT id FROM public.pages WHERE fb_page_id=ANY($1::text[])) ORDER BY contact_id,generation DESC`, [[...allowed]])).rows;
    const snapshotByContact = new Map(snapshots.map(snapshot => [snapshot.contact_id, snapshot]));
    const existingMetrics = (await db.query(`SELECT contact_id,source_cutoff_at,source_sha256 FROM public.contact_conversation_metrics WHERE page_id IN (SELECT id FROM public.pages WHERE fb_page_id=ANY($1::text[]))`, [[...allowed]])).rows;
    const metricByContact = new Map(existingMetrics.map(metric => [metric.contact_id, metric]));
    let batch = [];
    const flush = async () => {
        if (!batch.length) return;
        if (apply) {
            await db.query('BEGIN');
            try {
                await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='90s'");
                await db.query(`INSERT INTO public.contact_conversation_metrics(contact_id,page_id,source_cutoff_at,source_sha256,message_count,customer_message_count,page_message_count,customer_messages_replied,attachment_count,image_count)
                    SELECT r.contact_id,r.page_id,r.source_cutoff_at,r.source_sha256,r.message_count,r.customer_message_count,r.page_message_count,r.customer_messages_replied,r.attachment_count,r.image_count
                    FROM jsonb_to_recordset($1::jsonb) AS r(contact_id uuid,page_id uuid,source_cutoff_at timestamptz,source_sha256 text,message_count integer,customer_message_count integer,page_message_count integer,customer_messages_replied integer,attachment_count bigint,image_count bigint)
                    ON CONFLICT(contact_id) DO UPDATE SET page_id=EXCLUDED.page_id,source_cutoff_at=EXCLUDED.source_cutoff_at,source_sha256=EXCLUDED.source_sha256,message_count=EXCLUDED.message_count,customer_message_count=EXCLUDED.customer_message_count,page_message_count=EXCLUDED.page_message_count,customer_messages_replied=EXCLUDED.customer_messages_replied,attachment_count=EXCLUDED.attachment_count,image_count=EXCLUDED.image_count,derived_at=clock_timestamp()
                    WHERE EXCLUDED.source_cutoff_at>=contact_conversation_metrics.source_cutoff_at`, [JSON.stringify(batch)]);
                await db.query('COMMIT');
            } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
        }
        report.stored += batch.length; batch = [];
    };
    for (const row of records) {
        const contact = contactByIdentity.get(`${row.page_id}:${row.psid}`);
        if (!contact) continue;
        assert(contact.fb_page_id === row.facebook_page_id && allowed.has(contact.fb_page_id), 'Contact Page differs from approved local archive');
        const snapshot = snapshotByContact.get(contact.id);
        if (!snapshot || snapshot.page_id !== contact.page_id) continue;
        if (Date.parse(row.source_cutoff_at) < Date.parse(snapshot.source_cutoff_at)) { report.skipped_newer++; continue; }
        const current = metricByContact.get(contact.id);
        if (current && Date.parse(current.source_cutoff_at) > Date.parse(row.source_cutoff_at)) { report.already_current++; continue; }
        if (current && Date.parse(current.source_cutoff_at) === Date.parse(row.source_cutoff_at) && current.source_sha256 === row.source_sha256) { report.already_current++; continue; }
        const file = path.resolve(row.artifact);
        assert(file.startsWith(dir + path.sep), 'Prepared artifact escaped the local backlog');
        const compressed = fs.readFileSync(file);
        assert(digest(compressed) === row.artifact_sha256, 'Prepared artifact fingerprint changed');
        const artifact = JSON.parse(gunzipSync(compressed).toString('utf8'));
        verifyBacklogArtifact(artifact);
        assert(artifact.page_id === row.page_id && artifact.psid === row.psid && artifact.facebook_page_id === row.facebook_page_id && artifact.source_sha256 === row.source_sha256, 'Prepared artifact identity changed');
        // The completed archive preflight already verified every local source
        // file against this source hash; avoid rereading millions of chat lines.
        const messages = artifact.messages;
        let customer = 0, page = 0, replied = 0, attachments = 0, images = 0;
        for (let index = 0; index < messages.length; index++) {
            const message = messages[index];
            attachments += Number(message.attachments || 0); images += Number(message.images || 0);
            if (message.sender === 'page') page++;
            if (message.sender !== 'customer') continue;
            customer++;
            for (let next = index + 1; next < messages.length && messages[next].sender !== 'customer'; next++) {
                if (messages[next].sender === 'page') { replied++; break; }
            }
        }
        batch.push({ contact_id: contact.id, page_id: contact.page_id, source_cutoff_at: artifact.source_cutoff_at, source_sha256: artifact.source_sha256,
            message_count: messages.length, customer_message_count: customer, page_message_count: page, customer_messages_replied: replied, attachment_count: attachments, image_count: images });
        report.matched++; report.messages += messages.length; report.attachments += attachments; report.images += images;
        if (batch.length >= batchSize) await flush();
    }
    await flush();
    const result = { ...report, status: 'complete', raw_messages_written: 0 };
    fs.writeFileSync(path.join(dir, apply ? 'conversation-metrics-publish.json' : 'conversation-metrics-preflight.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
} catch (error) {
    report.errors.push({ message: error instanceof Error ? error.message : 'Unknown metrics publication error' });
    const result = { ...report, status: 'failed', raw_messages_written: 0 };
    fs.writeFileSync(path.join(dir, apply ? 'conversation-metrics-publish.json' : 'conversation-metrics-preflight.json'), JSON.stringify(result, null, 2));
    console.error(JSON.stringify(result));
    process.exitCode = 1;
} finally { await db.end(); }
