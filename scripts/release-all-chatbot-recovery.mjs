// Update every existing configured bot. Preserve on/off switches and contact holds.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
const marker = 'Current owner language and message policy (2026-10-17):';
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
const patchText = text => (text || '')
    .replace(/Match the customer['\u2019]s English, Filipino, or Taglish(?: naturally)?\./gi, 'Always use natural conversational Taglish.')
    .replace(/Use natural English, Filipino, or Taglish matching the customer\./gi, 'Always use natural conversational Taglish.')
    .replace(/in their language/gi, 'in natural Taglish')
    .replace(/in one short message/gi, 'in short conversational messages')
    .replace(/Keep one short message, usually 15-40 words\./gi, 'Keep ordinary conversational copy short, usually 15-40 words total; split the answer and next question.')
    .replace(/The full form is one intact message(?! by itself)/gi, 'The full form is one intact message by itself')
    .replace(/The complete form must be one message\./gi, 'The complete form must be one message by itself; answers, questions, and offers stay separate.');
await db.connect();
try {
    if (process.argv.includes('--apply-schema')) {
        if (!(await db.query("SELECT 1 FROM app_private.schema_migrations WHERE version='20261017_004'")).rowCount) {
            await db.query("SET lock_timeout='5s'; SET statement_timeout='30s'");
            await db.query(await readFile(new URL('../supabase/migrations/202610170004_chatbot_recovery_enrollment.sql',import.meta.url),'utf8'));
        }
        console.log('Recovery enrollment schema applied.');
    }
    await db.query('BEGIN');
    try {
        await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
        const configs = (await db.query('SELECT * FROM chatbot_configs ORDER BY page_id FOR UPDATE')).rows;
        assert.ok(configs.length, 'No configured bots found');
        assert.ok(configs.every(config => config.commercial_video_intake_enabled), 'Review non-commercial bots before applying commercial intake wording');
        const reference = configs.find(config => config.instructions?.includes(marker));
        assert.ok(reference, 'Owner-approved language policy is required');
        const policy = reference.instructions.slice(reference.instructions.indexOf(marker));
        assert.ok(policy.includes('Always use natural Taglish') && policy.includes('form ALONE'));
        if (!process.argv.includes('--apply')) {
            console.log(JSON.stringify({ mode: 'preview', configured: configs.length, enabled: configs.filter(config => config.enabled).length,
                settingsToUpdate: configs.filter(config => !config.instructions.includes(marker)).length }));
            await db.query('ROLLBACK');
        } else {
            const ids = configs.map(config => config.page_id);
            const states = (await db.query('SELECT * FROM chatbot_contact_states WHERE page_id=ANY($1::uuid[]) FOR UPDATE',[ids])).rows;
            const jobs = (await db.query("SELECT * FROM chatbot_follow_up_jobs WHERE page_id=ANY($1::uuid[]) AND status IN ('pending','processing','ready_manual') FOR UPDATE",[ids])).rows;
            const recovery = (await db.query('SELECT * FROM chatbot_inbound_recovery_pages WHERE page_id=ANY($1::uuid[]) FOR UPDATE',[ids])).rows;
            await writeFile(new URL(`../../data/all-chatbot-recovery-backup-${Date.now()}.json`,import.meta.url),JSON.stringify({configs,states,jobs,recovery},null,2),{flag:'wx'});
            let changed = 0;
            for (const original of configs) {
                let updated = original;
                if (!original.instructions.includes(marker) || !original.split_messages || original.max_message_parts !== 0) {
                    const keys = ['instructions','bot_dos','bot_donts','follow_up_prompt','follow_up_ai_instructions'];
                    const values = keys.map(key => original.instructions.includes(marker) ? original[key] : patchText(original[key])+'\n\n'+(key==='bot_donts'
                        ? 'Do not switch to English-only replies. Do not repeat unanswered questions or known fields. Do not attach answers, questions, or offers to the form message.' : policy));
                    updated = (await db.query(`UPDATE chatbot_configs SET ${keys.map((key,i)=>`${key}=$${i+2}`).join(',')},
                        split_messages=true,max_message_parts=0,updated_at=clock_timestamp() WHERE page_id=$1 RETURNING *`,[original.page_id,...values])).rows[0];
                    changed++;
                    for (const key of ['enabled','trial_mode_enabled','trial_contact_id','follow_up_enabled','rag_enabled','knowledge_source_page_id','follow_up_quick_delays_minutes','follow_up_best_time_days']) {
                        assert.deepEqual(updated[key],original[key],`Preserve ${key}`);
                    }
                    await db.query("UPDATE chatbot_contact_states SET policy_revision=$2 WHERE page_id=$1 AND status='active'",[original.page_id,updated.policy_revision]);
                    await db.query(`UPDATE chatbot_follow_up_jobs j SET policy_revision=$2 FROM chatbot_contact_states s WHERE j.page_id=$1 AND j.status='pending'
                        AND s.page_id=j.page_id AND s.contact_id=j.contact_id AND s.status='active' AND j.automation_epoch=s.automation_epoch`,[original.page_id,updated.policy_revision]);
                }
                await db.query(`INSERT INTO chatbot_inbound_recovery_pages(page_id,enabled,enabled_at) VALUES($1,$2,clock_timestamp())
                    ON CONFLICT(page_id) DO UPDATE SET enabled=EXCLUDED.enabled,
                    enabled_at=CASE WHEN chatbot_inbound_recovery_pages.enabled=EXCLUDED.enabled THEN chatbot_inbound_recovery_pages.enabled_at ELSE EXCLUDED.enabled_at END`,[original.page_id,original.enabled]);
            }
            await db.query('COMMIT');
            console.log(JSON.stringify({ updated:changed,configured:configs.length,activeRecoveryPages:configs.filter(config=>config.enabled).length,
                onOffSwitchesPreserved:true,contactResets:0 }));
        }
    } catch(error) { await db.query('ROLLBACK'); throw error; }
} finally { await db.end(); }
