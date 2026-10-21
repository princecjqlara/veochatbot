// Explicit all-bot settings update; no Messenger sends or contact resets.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
const marker = 'Form-first follow-up update (2026-10-17):';
const policy = `${marker} Always use natural Taglish. Prioritize completing Business Name, Business Location, Goal ng video, and Contact Number. Answer the customer's current question briefly using verified knowledge, then ask ONE conversational question about a still-missing required detail. After a partial answer, save every explicit detail and continue from there. Ask for the actual business name instead of only the business type. Use the business context naturally, without repeating its name or Salamat every time. Do not send an acknowledgement alone or only say pakifill-up when a specific missing-field question can help. Keep the full form ALONE in one message at introduction; after that, collect answers naturally in chat without requiring the customer to resend the whole form. Answer and next question stay separate when both are needed. Introduce the free concept/script offer separately as information, without asking them to choose an offer before the required details are collected. Required details take priority over optional duration, budget, style, format, and discovery questions. Remember known answers and rotate an ignored question to another missing field instead of repeating it. Once all four details are known, stop intake questions and proceed to the appropriate clarification or confirmed team handoff. Honor staff intervention, opt-outs, refusals, and existing stop rules.`;
const db = new pg.Client({connectionString:process.env.DATABASE_POOLER_URL_5432||process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await db.connect();
try {
    await db.query('BEGIN');
    try {
        await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
        const configs=(await db.query('SELECT * FROM chatbot_configs ORDER BY page_id FOR UPDATE')).rows;
        assert.ok(configs.length && configs.every(config=>config.commercial_video_intake_enabled),'Only existing commercial-video bots are in scope');
        const changed=configs.filter(config=>!config.instructions.includes(marker));
        if(!process.argv.includes('--apply')) {
            console.log(JSON.stringify({mode:'preview',configured:configs.length,toUpdate:changed.length,policy}));
            await db.query('ROLLBACK');
        } else {
            const ids=changed.map(config=>config.page_id);
            const states=(await db.query("SELECT * FROM chatbot_contact_states WHERE page_id=ANY($1::uuid[]) AND status='active' FOR UPDATE",[ids])).rows;
            const jobs=(await db.query("SELECT * FROM chatbot_follow_up_jobs WHERE page_id=ANY($1::uuid[]) AND status IN ('pending','processing','ready_manual') FOR UPDATE",[ids])).rows;
            if(changed.length) await writeFile(new URL(`../../data/form-priority-backup-${Date.now()}.json`,import.meta.url),JSON.stringify({configs,states,jobs},null,2),{flag:'wx'});
            for(const original of changed) {
                const keys=['instructions','bot_dos','bot_donts','follow_up_prompt','follow_up_ai_instructions'];
                const values=keys.map(key=>{
                    const text=original[key]||'';
                    const previous=text.indexOf('Current owner language and message policy (2026-10-17):');
                    const base=(previous<0?text:text.slice(0,previous)).trim().replace(/Do not force a question or promotion into every reply\./gi,
                        'Do not ask unrelated discovery questions while required intake details are missing.');
                    const updated=base+'\n\n'+(key==='bot_donts'
                        ? 'Do not divert incomplete intake into offer choices, optional duration/budget/style questions, repeated pitches, or a generic form reminder. Do not re-ask known details or require the whole form again after partial answers.' : policy);
                    assert.ok(updated.length<=(key==='instructions'?5000:3000),`${key} exceeds its saved-settings limit`);
                    return updated;
                });
                const updated=(await db.query(`UPDATE chatbot_configs SET ${keys.map((key,i)=>`${key}=$${i+2}`).join(',')},updated_at=clock_timestamp()
                    WHERE page_id=$1 RETURNING *`,[original.page_id,...values])).rows[0];
                for(const key of ['enabled','split_messages','max_message_parts','trial_mode_enabled','trial_contact_id','follow_up_enabled','rag_enabled','knowledge_source_page_id','follow_up_quick_delays_minutes','follow_up_best_time_days']) {
                    assert.deepEqual(updated[key],original[key],`Preserve ${key}`);
                }
                await db.query("UPDATE chatbot_contact_states SET policy_revision=$2 WHERE page_id=$1 AND status='active'",[original.page_id,updated.policy_revision]);
                await db.query(`UPDATE chatbot_follow_up_jobs j SET policy_revision=$2 FROM chatbot_contact_states s
                    WHERE j.page_id=$1 AND j.status='pending' AND s.page_id=j.page_id AND s.contact_id=j.contact_id
                    AND s.status='active' AND j.automation_epoch=s.automation_epoch`,[original.page_id,updated.policy_revision]);
            }
            await db.query('COMMIT');
            console.log(JSON.stringify({updated:changed.length,configured:configs.length,contactResets:0,schedulesPreserved:true}));
        }
    } catch(error) { await db.query('ROLLBACK'); throw error; }
} finally { await db.end(); }
