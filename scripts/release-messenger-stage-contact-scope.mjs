import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import pg from 'pg';
import { assertProjectCredentials, VEO_TARGET_PROJECT, digest } from './lib/database-migration-safety.mjs';

const apply = process.argv.includes('--apply');
assert(apply || process.argv.includes('--preflight'), 'Choose --preflight or --apply');
const { parse } = createRequire(import.meta.url)('dotenv');
const env = parse(fs.readFileSync('.env.local', 'utf8'));
const { connectionString } = assertProjectCredentials(env, VEO_TARGET_PROJECT);
const migrationName = '202611050007_scope_stage_events_to_contact.sql';
const migration = fs.readFileSync(path.join('supabase/migrations', migrationName), 'utf8');
const sql = migration.replace(/^[ \t]*BEGIN;[ \t]*$/gm, '').replace(/^[ \t]*COMMIT;[ \t]*$/gm, '');
const audit = JSON.parse(fs.readFileSync('.vercel/veo-backlog/stage-audit-corrections.json', 'utf8'));
const corrections = audit.latest_stage_mismatch.filter(row => row.stage_event_exists === false
    && row.current_stage === 'new' && row.current_source === 'system' && row.source_stage === 'qualified');
assert.equal(corrections.length, 2, 'The reviewed two-contact stage repair scope changed');

const backlog = path.resolve('.vercel/veo-backlog');
const manifests = fs.readFileSync(path.join(backlog, 'prepared-manifest.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const latest = new Map(manifests.map(row => [`${row.page_id}:${row.psid}`, row]));
for (const file of fs.readdirSync(path.join(backlog, 'refreshed')).filter(name => name.endsWith('.profile.json.gz'))) {
    const full = path.join(backlog, 'refreshed', file), artifact = JSON.parse(gunzipSync(fs.readFileSync(full)).toString('utf8'));
    const key = `${artifact.page_id}:${artifact.psid}`, previous = latest.get(key);
    if (!previous || Date.parse(artifact.source_cutoff_at) > Date.parse(previous.source_cutoff_at)) latest.set(key, {
        page_id: artifact.page_id, psid: artifact.psid, facebook_page_id: artifact.facebook_page_id,
        source_sha256: artifact.source_sha256, source_cutoff_at: artifact.source_cutoff_at,
        artifact: path.relative(process.cwd(), full), verified: true
    });
}

const pages = JSON.parse(fs.readFileSync('src/config/veo-pages.json', 'utf8'));
const targets = corrections.map(row => {
    const configured = pages.find(page => page.name.trim() === row.page.trim());
    assert(configured?.facebook_page_id, 'Stage event Page is not configured for VeoBot');
    const source = [...latest.values()].find(item => item.psid === row.psid && item.facebook_page_id === configured.facebook_page_id);
    assert(source && source.verified !== false && source.source_sha256, 'A verified local source is missing');
    const file = path.resolve(source.artifact);
    assert(file.startsWith(backlog + path.sep), 'Local source path escaped the retained backlog');
    const artifact = JSON.parse(gunzipSync(fs.readFileSync(file)).toString('utf8'));
    assert(artifact.page_id === source.page_id && artifact.psid === row.psid && artifact.source_sha256 === source.source_sha256,
        'Local source identity or hash does not match the manifest');
    const event = artifact.payload?.stage_events?.find(item => item.messageId === row.source_message_id);
    assert(event && event.stage === row.source_stage && Date.parse(event.occurredAt) === Date.parse(row.source_at),
        'Stage event is not present in the verified local conversation');
    assert(Date.parse(artifact.source_cutoff_at) >= Date.parse(row.source_at), 'Local conversation cutoff predates the stage notice');
    assert(configured?.facebook_page_id === source.facebook_page_id, 'Stage event Page does not match the configured VeoBot Page');
    return { ...row, page_id: source.page_id, fb_page_id: source.facebook_page_id, source_sha256: source.source_sha256 };
});

const db = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 25000, query_timeout: 120000 });
const report = { target_project: VEO_TARGET_PROJECT, applied: false, migration: migrationName, verified_local_events: targets.length, repair_events_applied: 0 };
await db.connect();
try {
    if (apply) {
        await db.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE');
        assert.equal((await db.query("SELECT current_setting('transaction_read_only') value")).rows[0].value, 'off', 'Target database is read only');
    }
    await db.query('BEGIN');
    try {
        const before = (await db.query(`SELECT
            (SELECT count(*) FROM public.contacts) contacts,
            (SELECT count(*) FROM public.tags) tags,
            (SELECT count(*) FROM public.contact_tags) contact_tags,
            (SELECT count(*) FROM public.contact_verified_payments) verified_payments,
            (SELECT md5(coalesce(string_agg(to_jsonb(c)::text,',' ORDER BY c.page_id),'')) FROM public.chatbot_configs c) chatbot_configs`)).rows[0];
        await db.query(sql);
        const repaired = [];
        for (const row of targets) {
            const current = (await db.query(`SELECT c.pipeline_stage,c.pipeline_stage_source,c.messenger_stage_event_at,
                EXISTS(SELECT 1 FROM public.messenger_lead_stage_events e WHERE e.page_id=c.page_id AND e.contact_id=c.id AND e.message_id=$2) contact_event_exists
                FROM public.contacts c WHERE c.id=$1 AND c.page_id=$3 FOR UPDATE`, [row.contact_id, row.source_message_id, row.page_id])).rows[0];
            assert(current && current.pipeline_stage === 'new' && current.pipeline_stage_source === 'system'
                && !current.messenger_stage_event_at && !current.contact_event_exists, 'Contact changed after stage audit');
            const applied = (await db.query('SELECT public.apply_messenger_lead_stage($1::uuid,$2::uuid,$3::text,$4::text,$5::text,$6::timestamptz) result',
                [row.page_id, row.contact_id, row.source_message_id, row.source_label, row.source_stage, row.source_at])).rows[0].result;
            assert.equal(applied?.applied, true, `The verified ${row.page} stage event could not be applied: ${applied?.reason || 'unknown reason'}`);
            const saved = (await db.query(`SELECT e.applied,c.pipeline_stage FROM public.messenger_lead_stage_events e
                JOIN public.contacts c ON c.id=e.contact_id AND c.page_id=e.page_id
                WHERE e.page_id=$1 AND e.contact_id=$2 AND e.message_id=$3`, [row.page_id, row.contact_id, row.source_message_id])).rows[0];
            assert(saved?.applied && saved.pipeline_stage === row.source_stage, 'Stage event or current contact stage did not persist');
            repaired.push({ page: row.page, stage: row.source_stage, occurred_at: row.source_at });
        }
        const after = (await db.query(`SELECT
            (SELECT count(*) FROM public.contacts) contacts,
            (SELECT count(*) FROM public.tags) tags,
            (SELECT count(*) FROM public.contact_tags) contact_tags,
            (SELECT count(*) FROM public.contact_verified_payments) verified_payments,
            (SELECT md5(coalesce(string_agg(to_jsonb(c)::text,',' ORDER BY c.page_id),'')) FROM public.chatbot_configs c) chatbot_configs`)).rows[0];
        assert.deepEqual({ contacts: after.contacts, verified_payments: after.verified_payments, chatbot_configs: after.chatbot_configs },
            { contacts: before.contacts, verified_payments: before.verified_payments, chatbot_configs: before.chatbot_configs }, 'Contact inventory, payments or chatbot setup changed');
        assert.equal(Number(after.tags) - Number(before.tags), 0, 'Expected existing stage history tags to be reused');
        assert.equal(Number(after.contact_tags) - Number(before.contact_tags), targets.length, 'The stage history tags were not applied to each affected contact');
        if (apply) {
            await db.query('INSERT INTO app_private.veobot_project_migrations(filename,sha256,project_ref) VALUES($1,$2,$3) ON CONFLICT(filename) DO NOTHING',
                [migrationName, digest(migration), VEO_TARGET_PROJECT]);
            await db.query('COMMIT');
            report.applied = true;
        } else await db.query('ROLLBACK');
        report.repair_events_applied = repaired.length;
        report.repaired = repaired;
        report.preserved = { contacts: before.contacts, verified_payments: before.verified_payments, chatbot_configs: before.chatbot_configs };
        report.passed = true;
    } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
} catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
finally {
    await db.end();
    fs.writeFileSync(`.vercel/veo-backlog/stage-contact-scope-${apply ? 'apply' : 'preflight'}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
}
