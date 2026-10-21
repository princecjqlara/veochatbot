// Scoped release operations. No customer message replay. Read-only by default.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
const pageId = 'b33a9b46-6470-48ed-bcfc-4235aa46f241';
const contactId = '5dc31f3d-29db-440d-93cd-0b76c7bfb6d9';
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
const backup = async (kind, value) => writeFile(new URL(`../../data/manawari-${kind}-${Date.now()}.json`, import.meta.url), JSON.stringify(value, null, 2), { flag: 'wx' });
const policy = `Current owner language and message policy (2026-10-17): Always use natural Taglish, even for English inquiries. Answer the current question using verified Page knowledge, then prioritize one missing required detail: Business Name, Business Location, Goal ng video, Contact Number. Remember partial answers and corrections. Do not repeat greetings, pitches, supplied fields, or the same unanswered question. If a field was just ignored, ask another missing field naturally. Keep ordinary conversational copy short, usually 15-40 words total. Send answers and follow-up questions as separate messages when both are needed. Send the entire four-field form ALONE in one message. Send the free concept or free script offer separately at introduction; do not repeat it on every reply. No free personalized videos or invented offers. Staff intervention and existing stop rules still apply.`;
function patchText(text) {
    return (text || '')
        .replace(/Match the customer['’]s English, Filipino, or Taglish(?: naturally)?\./gi, 'Always use natural conversational Taglish.')
        .replace(/Use natural English, Filipino, or Taglish matching the customer\./gi, 'Always use natural conversational Taglish.')
        .replace(/in their language/gi, 'in natural Taglish')
        .replace(/in one short message/gi, 'in short conversational messages')
        .replace(/Keep one short message, usually 15-40 words\./gi, 'Keep ordinary conversational copy short, usually 15-40 words total; split the answer and next question.')
        .replace(/The full form is one intact message/gi, 'The full form is one intact message by itself')
        .replace(/The complete form must be one message\./gi, 'The complete form must be one message by itself; answers, questions, and offers stay separate.');
}
await db.connect();
try {
    if (process.argv.includes('--apply-schema')) {
        const applied = await db.query("SELECT 1 FROM app_private.schema_migrations WHERE version='20261017_003'");
        if (!applied.rowCount) {
            await db.query("SET lock_timeout='5s'; SET statement_timeout='30s'");
            await db.query(await readFile(new URL('../supabase/migrations/202610170003_chatbot_inbound_recovery.sql', import.meta.url), 'utf8'));
        }
        console.log('Recovery schema is applied; no Pages automatically enabled.');
    }
    if (process.argv.includes('--apply-settings')) {
        await db.query('BEGIN');
        try {
            const original = (await db.query('SELECT * FROM chatbot_configs WHERE page_id=$1 FOR UPDATE', [pageId])).rows[0];
            assert.ok(original?.commercial_video_intake_enabled && original?.enabled, 'Manawari chatbot must already be active');
            assert.ok(!original.instructions.includes('Current owner language and message policy (2026-10-17)'), 'Language policy already applied');
            const states = (await db.query('SELECT * FROM chatbot_contact_states WHERE page_id=$1 FOR UPDATE', [pageId])).rows;
            const jobs = (await db.query("SELECT * FROM chatbot_follow_up_jobs WHERE page_id=$1 AND status IN ('pending','processing','ready_manual') FOR UPDATE", [pageId])).rows;
            await backup('language-settings-backup', { config: original, states, jobs });
            const keys = ['instructions', 'bot_dos', 'bot_donts', 'follow_up_prompt', 'follow_up_ai_instructions'];
            const values = keys.map(key => patchText(original[key]) + '\n\n' + (key === 'bot_donts'
                ? 'Do not switch to English-only replies. Do not repeat unanswered questions or known fields. Do not attach answers, questions, or offers to the form message.' : policy));
            const updated = (await db.query(`UPDATE chatbot_configs SET ${keys.map((key, i) => `${key}=$${i + 2}`).join(',')},
                split_messages=true,max_message_parts=0,updated_at=clock_timestamp() WHERE page_id=$1 RETURNING *`, [pageId, ...values])).rows[0];
            for (const key of ['enabled','trial_mode_enabled','trial_contact_id','follow_up_enabled','rag_enabled','knowledge_source_page_id','follow_up_quick_delays_minutes','follow_up_best_time_days']) {
                assert.deepEqual(updated[key], original[key], `Preserve ${key}`);
            }
            // Future reminders generate fresh copy at send time. Preserve their
            // schedule and eligibility; never revive cancelled or stopped work.
            await db.query(`UPDATE chatbot_contact_states SET policy_revision=$2 WHERE page_id=$1 AND status='active'`, [pageId, updated.policy_revision]);
            await db.query(`UPDATE chatbot_follow_up_jobs j SET policy_revision=$2 FROM chatbot_contact_states s
                WHERE j.page_id=$1 AND j.status='pending' AND s.page_id=j.page_id AND s.contact_id=j.contact_id
                AND s.status='active' AND j.automation_epoch=s.automation_epoch`, [pageId, updated.policy_revision]);
            await db.query('COMMIT');
            console.log(JSON.stringify({ settingsUpdated: 'Manawari Studios', policyRevision: updated.policy_revision, split: true, mode: 'automatic' }));
        } catch (error) { await db.query('ROLLBACK'); throw error; }
    }
    if (process.argv.includes('--enable-recovery')) {
        const old = (await db.query('SELECT * FROM chatbot_inbound_recovery_pages WHERE page_id=$1', [pageId])).rows;
        await backup('recovery-activation-backup', old);
        await db.query(`INSERT INTO chatbot_inbound_recovery_pages(page_id,enabled,enabled_at) VALUES($1,true,clock_timestamp())
            ON CONFLICT(page_id) DO UPDATE SET enabled=true,enabled_at=CASE WHEN chatbot_inbound_recovery_pages.enabled
                THEN chatbot_inbound_recovery_pages.enabled_at ELSE clock_timestamp() END,scan_cursor=NULL`, [pageId]);
        console.log('Recent inbound recovery enabled for Manawari Studios only. Earlier unanswered backlog excluded.');
    }
    if (process.argv.includes('--reset-test-chat')) {
        const contact = (await db.query('SELECT * FROM contacts WHERE page_id=$1 AND id=$2', [pageId, contactId])).rows[0];
        assert.equal(contact?.name, 'Cj Lara', 'Only the owner test contact can be restarted');
        const state = (await db.query('SELECT * FROM chatbot_contact_states WHERE page_id=$1 AND contact_id=$2', [pageId, contactId])).rows;
        const jobs = (await db.query('SELECT * FROM chatbot_follow_up_jobs WHERE page_id=$1 AND contact_id=$2', [pageId, contactId])).rows;
        const reviews = (await db.query('SELECT * FROM chatbot_continuation_reviews WHERE page_id=$1 AND contact_id=$2', [pageId, contactId])).rows;
        await backup('fresh-test-backup', { contact, state, jobs, reviews });
        await db.query('SELECT reset_chatbot_contact($1,$2)', [pageId, contactId]);
        console.log('Owner test chat restarted for a NEW Messenger message. No old inbound replayed.');
    }
    const config = (await db.query(`SELECT enabled,split_messages,max_message_parts,policy_revision,
        instructions,bot_dos,bot_donts,follow_up_ai_instructions FROM chatbot_configs WHERE page_id=$1`, [pageId])).rows[0];
    const state = (await db.query(`SELECT status,stop_reason,pause_kind,last_inbound_at,last_bot_reply_at,messenger_history_reset_at
        FROM chatbot_contact_states WHERE page_id=$1 AND contact_id=$2`, [pageId, contactId])).rows[0];
    console.log(JSON.stringify({ config: process.argv.includes('--inspect') ? config : { enabled: config.enabled, split: config.split_messages, revision: config.policy_revision }, testState: state }));
} finally { await db.end(); }
