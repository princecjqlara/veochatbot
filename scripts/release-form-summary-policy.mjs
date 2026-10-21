// Preview by default. --apply updates saved prompts only; sends no messages.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { COMMERCIAL_VIDEO_REQUIRED_DETAILS, COMMERCIAL_VIDEO_OWNER_POLICY, COMMERCIAL_VIDEO_OWNER_POLICY_MARKER, commercialVideoOwnerGuidance } from '../src/lib/chatbot-intake.ts';

const promptKeys = ['instructions', 'bot_dos', 'bot_donts', 'follow_up_prompt', 'follow_up_ai_instructions'];
const markers = [COMMERCIAL_VIDEO_OWNER_POLICY_MARKER, 'Natural follow-up and free-concept sales policy (2026-10-21):', 'Business sample duration and single-message sales policy (2026-10-21):', 'Form incentive and sentence splitting policy (2026-10-18):', 'Compact form-first conversation policy (2026-10-18):', 'Form-first split and follow-up policy (2026-10-18):', 'Form-first summary and pricing policy (2026-10-17):', 'Form-first follow-up update (2026-10-17):',
    'Current owner language and message policy (2026-10-17):', 'Current commercial-video intake policy:'];
const stripPolicy = text => {
    const positions = markers.map(marker => (text || '').indexOf(marker)).filter(index => index >= 0);
    return (positions.length ? text.slice(0, Math.min(...positions)) : text || '').trim();
};
const fallback = 'Anong business ang gusto mong gawan ng commercial video?';
function patch(original) {
    const updated = { ...original };
    for (const key of promptKeys) {
        const base = commercialVideoOwnerGuidance(stripPolicy(original[key]));
        if (key === 'bot_donts') {
            updated[key] = base + '\n\n' + COMMERCIAL_VIDEO_OWNER_POLICY_MARKER +
                ' No emojis, invented quotes, price catalogs, repeated pitches or near-identical question/reminder construction, free personalized video promises, or fees for free concept/script. Forms and relevant existing samples may repeat when useful. Split ordinary sentences naturally; keep pricing, process and form intact. Explain the no-fee free concept with forms and prices. Respect explicit lead-stage stops, holds and Page switches. At 23:59 PH resume temporary staff pauses only without paid-video or free-output agreement; missing fields alone never reopen an accepted request.';
        } else if (key.startsWith('follow_up_')) {
            // Keep custom follow-up guidance alongside the current policy.
            updated[key] = base + "\n\n" + COMMERCIAL_VIDEO_OWNER_POLICY;
        } else {
            updated[key] = base + '\n\n' + COMMERCIAL_VIDEO_OWNER_POLICY;
        }
        assert.ok(updated[key].length <= (key === 'instructions' ? 5000 : 3000), `${key} exceeds saved-settings limit`);
    }
    updated.fallback_reply = fallback;
    updated.details_to_collect = [...COMMERCIAL_VIDEO_REQUIRED_DETAILS];
    updated.details_completion_percent = 100;
    return updated;
}

if (process.argv.includes('--offline-preview')) {
    const directory = new URL('../../data/', import.meta.url);
    const files = (await readdir(directory)).filter(name => /^form-summary-policy-backup-\d+\.json$/.test(name)).sort();
    assert.ok(files.length, 'A saved-settings backup is required');
    const backup = JSON.parse(await readFile(new URL(files.at(-1), directory), 'utf8'));
    const previews = backup.configs.map(original => {
        const updated = patch(original);
        return { pageId: original.page_id, fields: Object.fromEntries(promptKeys.map(key => [key, updated[key].length])) };
    });
    console.log(JSON.stringify({ mode: 'offline-preview', configured: previews.length, lengths: previews, databaseWrites: 0 }));
    process.exit(0);
}

const connectionString = process.argv.includes('--transaction-pooler') ? process.env.DATABASE_POOLER_URL_6543
    : process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL;
const db = new pg.Client({ connectionString,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 45000 });
await db.connect();
try {
    if (process.argv.includes('--apply-schema')) {
        const installed = await db.query("SELECT 1 FROM app_private.schema_migrations WHERE version='20261021_002'");
        if (!installed.rowCount) await db.query(await readFile(new URL('../supabase/migrations/202610210002_interactive_eight_field_intake.sql', import.meta.url), 'utf8'));
        console.log(JSON.stringify({ eightFieldSchemaReady: true }));
    }
    await db.query('BEGIN');
    try {
        await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
        const configs = (await db.query('SELECT * FROM chatbot_configs WHERE commercial_video_intake_enabled=true ORDER BY page_id FOR UPDATE')).rows;
        assert.ok(configs.length, 'No configured commercial-video bots found');
        const changes = configs.map(original => ({ original, updated: patch(original) }))
            .filter(({ original, updated }) => [...promptKeys, 'fallback_reply', 'details_to_collect', 'details_completion_percent'].some(key => JSON.stringify(original[key]) !== JSON.stringify(updated[key])));
        if (!process.argv.includes('--apply')) {
            console.log(JSON.stringify({ mode: 'preview', configured: configs.length, toUpdate: changes.length,
                policy: COMMERCIAL_VIDEO_OWNER_POLICY, lengths: changes.map(({ original, updated }) => ({ pageId: original.page_id,
                    fields: Object.fromEntries(promptKeys.map(key => [key, updated[key].length])) })) }));
            await db.query('ROLLBACK');
        } else {
            const ids = changes.map(({ original }) => original.page_id);
            const states = (await db.query("SELECT page_id,contact_id,policy_revision,automation_epoch FROM chatbot_contact_states WHERE page_id=ANY($1::uuid[]) AND status='active' FOR UPDATE", [ids])).rows;
            const jobs = (await db.query("SELECT id,page_id,contact_id,policy_revision,automation_epoch,due_at,status FROM chatbot_follow_up_jobs WHERE page_id=ANY($1::uuid[]) AND status IN ('pending','processing','ready_manual') FOR UPDATE", [ids])).rows;
            const directory = new URL('../../data/', import.meta.url);
            await mkdir(directory, { recursive: true });
            if (changes.length) await writeFile(new URL(`form-summary-policy-backup-${Date.now()}.json`, directory), JSON.stringify({ configs, states, jobs }, null, 2), { flag: 'wx' });
            for (const { original, updated } of changes) {
                const keys = [...promptKeys, 'fallback_reply', 'details_to_collect', 'details_completion_percent'];
                const saved = (await db.query(`UPDATE chatbot_configs SET ${keys.map((key, index) => `${key}=$${index + 2}`).join(',')},updated_at=clock_timestamp() WHERE page_id=$1 RETURNING *`, [original.page_id, ...keys.map(key => key === 'details_to_collect' ? JSON.stringify(updated[key]) : updated[key])])).rows[0];
                for (const key of Object.keys(original).filter(key => !keys.includes(key) && !['updated_at', 'policy_revision'].includes(key))) {
                    assert.deepEqual(saved[key], original[key], `Preserve ${key}`);
                }
                await db.query("UPDATE chatbot_contact_states SET policy_revision=$2 WHERE page_id=$1 AND status='active'", [original.page_id, saved.policy_revision]);
                await db.query(`UPDATE chatbot_follow_up_jobs j SET policy_revision=$2 FROM chatbot_contact_states s
                    WHERE j.page_id=$1 AND j.status='pending' AND s.page_id=j.page_id AND s.contact_id=j.contact_id
                    AND s.status='active' AND j.automation_epoch=s.automation_epoch`, [original.page_id, saved.policy_revision]);
            }
            await db.query('COMMIT');
            console.log(JSON.stringify({ configured: configs.length, updated: changes.length, schedulesPreserved: true, contactResets: 0, messengerMessagesSent: 0 }));
        }
    } catch (error) { await db.query('ROLLBACK'); throw error; }
} finally { await db.end(); }
