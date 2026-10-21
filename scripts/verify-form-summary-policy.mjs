// Saved-settings read-back only; no Messenger sends or contact writes.
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { COMMERCIAL_VIDEO_REQUIRED_DETAILS, COMMERCIAL_VIDEO_OWNER_POLICY, COMMERCIAL_VIDEO_OWNER_POLICY_MARKER } from '../src/lib/chatbot-intake.ts';
const directory = new URL('../../data/', import.meta.url);
const files = (await readdir(directory)).filter(name => /^form-summary-policy-backup-\d+\.json$/.test(name)).sort();
assert.ok(files.length, 'A pre-update settings backup is required');
const before = JSON.parse(await readFile(new URL(files.at(-1), directory), 'utf8'));
const expectDisabled = process.argv.includes('--expect-disabled');
const enabledPageIndex = process.argv.indexOf('--enabled-page');
const enabledPageId = enabledPageIndex >= 0 ? process.argv[enabledPageIndex + 1] : null;
const db = new pg.Client({ connectionString: process.argv.includes('--transaction-pooler') ? process.env.DATABASE_POOLER_URL_6543
    : process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000, query_timeout: 20000 });
await db.connect();
try {
    const rows = (await db.query('SELECT c.*,p.name FROM chatbot_configs c JOIN pages p ON p.id=c.page_id WHERE c.page_id=ANY($1::uuid[]) ORDER BY p.name', [before.configs.map(row => row.page_id)])).rows;
    assert.equal(rows.length, before.configs.length);
    const promptKeys = ['instructions','bot_dos','bot_donts','follow_up_prompt','follow_up_ai_instructions'];
    const checks = [];
    for (const row of rows) {
        const original = before.configs.find(config => config.page_id === row.page_id);
        assert.equal(row.split_messages, true, `${row.name}: split messaging stays enabled`);
        assert.equal(row.max_message_parts, 0, `${row.name}: automatic splitting stays enabled`);
        assert.deepEqual(row.details_to_collect, COMMERCIAL_VIDEO_REQUIRED_DETAILS, `${row.name}: all eight fields`);
        assert.equal(row.details_completion_percent, 100);
        if (expectDisabled) assert.equal(row.enabled, false, `${row.name}: owner requested all bots off`);
        for (const key of Object.keys(original).filter(key => ![...promptKeys, 'fallback_reply', 'details_to_collect', 'details_completion_percent', 'policy_revision', 'updated_at'].includes(key))) {
            if (enabledPageId && key === 'enabled') { assert.equal(row.enabled, row.page_id === enabledPageId); continue; }
            if (expectDisabled && key === 'enabled') continue;
            assert.deepEqual(row[key] instanceof Date ? row[key].toISOString() : row[key], original[key], `${row.name}: preserve ${key}`);
        }
        for (const key of promptKeys) {
            assert.ok(row[key].includes(COMMERCIAL_VIDEO_OWNER_POLICY_MARKER), `${row.name}: ${key} updated`);
            assert.ok(!row[key].includes('Form incentive and sentence splitting policy'), `${row.name}: superseded sentence splitting removed`);
            assert.ok(!row[key].includes('Form-first follow-up update'), `${row.name}: superseded policy removed`);
            assert.ok(!row[key].includes('Form-first split and follow-up policy'), `${row.name}: superseded offer layout removed`);
            assert.ok(!row[key].includes('Compact form-first conversation policy'), `${row.name}: superseded merged-answer layout removed`);
            if (key !== 'bot_donts') assert.ok(row[key].includes(COMMERCIAL_VIDEO_OWNER_POLICY), `${row.name}: complete ${key} policy`);
            assert.ok(row[key].length <= (key === 'instructions' ? 5000 : 3000));
        }
        assert.ok(row.fallback_reply.includes('Anong business'));
        checks.push({ page: row.name.trim(), enabled: row.enabled, promptsUpdated: promptKeys.length, businessSampleDurationPricingProcessForm: true, noPriceCatalogsOrAiBranding: true, passed: true });
    }
    const stale = (await db.query(`SELECT count(*)::int AS count FROM chatbot_follow_up_jobs j JOIN chatbot_contact_states s ON s.page_id=j.page_id AND s.contact_id=j.contact_id
        JOIN chatbot_configs c ON c.page_id=j.page_id WHERE c.page_id=ANY($1::uuid[]) AND j.status='pending' AND s.status='active'
        AND j.automation_epoch=s.automation_epoch AND j.policy_revision<>c.policy_revision`, [rows.map(row => row.page_id)])).rows[0].count;
    assert.equal(stale, 0, 'Pending eligible reminders adopt the new policy');
    assert.deepEqual((await db.query('SELECT page_id FROM chatbot_inbound_recovery_pages WHERE enabled ORDER BY page_id')).rows.map(row => row.page_id), rows.filter(row => row.enabled).map(row => row.page_id).sort(), 'Recovery switches match the saved Page switches');
    if (expectDisabled) {
        assert.equal((await db.query('SELECT count(*)::integer AS count FROM chatbot_configs WHERE enabled')).rows[0].count, 0);
        assert.equal((await db.query('SELECT count(*)::integer AS count FROM chatbot_inbound_recovery_pages WHERE enabled')).rows[0].count, 0);
        assert.equal((await db.query("SELECT count(*)::integer AS count FROM chatbot_follow_up_jobs WHERE status IN ('pending','processing','ready_manual')")).rows[0].count, 0);
    }
    if (enabledPageId) {
        assert.deepEqual((await db.query('SELECT page_id FROM chatbot_configs WHERE enabled ORDER BY page_id')).rows.map(row => row.page_id), [enabledPageId]);
        assert.deepEqual((await db.query('SELECT page_id FROM chatbot_inbound_recovery_pages WHERE enabled ORDER BY page_id')).rows.map(row => row.page_id), [enabledPageId]);
    }
    const report = { at: new Date().toISOString(), configured: rows.length, checks, stalePendingReminders: stale, messengerMessagesSent: 0 };
    await writeFile(new URL('form-summary-policy-readback.json', directory), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
} finally { await db.end(); }
