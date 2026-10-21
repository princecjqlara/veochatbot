import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
const directory = new URL('../../data/',import.meta.url);
const files = (await readdir(directory)).filter(name=>/^all-chatbot-recovery-backup-\d+\.json$/.test(name)).sort();
assert.ok(files.length,'A pre-rollout settings backup is required');
const before = JSON.parse(await readFile(new URL(files.at(-1),directory),'utf8'));
const db = new pg.Client({connectionString:process.env.DATABASE_POOLER_URL_5432||process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
await db.connect();
try {
    const rows = (await db.query(`SELECT c.*,p.name,r.enabled AS recovery_enabled,r.enabled_at AS recovery_since,r.checked_at,r.last_error,r.lease_until AS recovery_lease_until
        FROM chatbot_configs c JOIN pages p ON p.id=c.page_id LEFT JOIN chatbot_inbound_recovery_pages r ON r.page_id=c.page_id ORDER BY p.name`)).rows;
    const checks = [];
    for (const row of rows) {
        const original = before.configs.find(config=>config.page_id===row.page_id);
        assert.ok(original,'Unexpected new bot requires a refreshed rollout audit');
        for (const key of ['enabled','trial_mode_enabled','trial_contact_id','follow_up_enabled','rag_enabled','knowledge_source_page_id','follow_up_quick_delays_minutes','follow_up_best_time_days']) {
            assert.deepEqual(row[key],original[key],`${row.name}: preserve ${key}`);
        }
        assert.equal(row.split_messages,true); assert.equal(row.max_message_parts,0);
        for(const key of ['instructions','bot_dos','follow_up_prompt','follow_up_ai_instructions']) assert.ok(row[key].includes('Always use natural Taglish'),`${row.name}: ${key}`);
        if (process.argv.includes('--require-form-priority')) {
            for (const key of ['instructions','bot_dos','follow_up_prompt','follow_up_ai_instructions']) assert.ok(/(?:Form-first (?:follow-up update|summary and pricing policy|split and follow-up policy)|Compact form-first conversation policy|Form incentive and sentence splitting policy) \(2026-10-(?:17|18)\):/.test(row[key]),`${row.name}: form priority in ${key}`);
        }
        assert.ok(!/Match the customer's English|in one short message|Keep one short message/i.test(row.instructions+'\n'+row.bot_dos),`${row.name}: obsolete instructions removed`);
        assert.equal(row.recovery_enabled,row.enabled,`${row.name}: recovery follows bot switch`);
        if (process.argv.includes('--require-worker') && row.enabled) {
            assert.ok(row.checked_at && Date.now()-Date.parse(row.checked_at)<6*60000,`${row.name}: worker has checked this Page recently`);
            assert.equal(row.last_error,null,`${row.name}: recovery read error`);
            assert.equal(row.recovery_lease_until,null,`${row.name}: recovery scan is still in progress`);
        }
        checks.push({page:row.name.trim(),enabled:row.enabled,taglish:true,split:true,recovery:row.recovery_enabled,checkedAt:row.checked_at,lastError:row.last_error,passed:true});
    }
    assert.equal(rows.length,before.configs.length);
    const outcomes=(await db.query(`SELECT count(*)::integer AS handled_events,
        count(*) FILTER(WHERE replies.status='sent')::integer AS delivered_replies
        FROM chatbot_inbound_recovery_events events JOIN chatbot_inbound_recovery_pages recovery ON recovery.page_id=events.page_id
        LEFT JOIN chatbot_reply_events replies ON replies.page_id=events.page_id AND replies.inbound_message_id=events.message_id
        WHERE events.page_id=ANY($1::uuid[]) AND events.inbound_at>=recovery.enabled_at`,[rows.map(row=>row.page_id)])).rows[0];
    const report={at:new Date().toISOString(),configured:rows.length,active:rows.filter(row=>row.enabled).length,checks,recoveryOutcomes:outcomes,customerMessagesSent:0};
    await writeFile(new URL('all-chatbot-recovery-readback.json',directory),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
} finally { await db.end(); }
