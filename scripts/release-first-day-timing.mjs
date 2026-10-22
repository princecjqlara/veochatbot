// Preview by default. Apply schema before deployment; activate after the new
// production application is ready. Does not invoke a worker or send messages.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { buildFirstDaySchedule, FIRST_DAY_TIMING } from '../src/lib/chatbot-first-day-timing.ts';

const out = new URL('../../data/', import.meta.url);
const applySchema = process.argv.includes('--apply-schema');
const activate = process.argv.includes('--activate');
assert.ok(!(applySchema && activate), 'Schema and activation must be separate release steps');
const db = new pg.Client({
    connectionString: process.env.DATABASE_POOLER_URL_6543 || process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000, query_timeout: 45_000
});
await db.connect();
try {
    if (applySchema) {
        await db.query(await readFile(new URL('../supabase/migrations/202610220001_chatbot_first_day_timing.sql', import.meta.url), 'utf8'));
        const columns = (await db.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND (table_name,column_name) IN (('chatbot_configs','follow_up_first_day_mode'),('chatbot_follow_up_jobs','timing_context'))")).rows;
        assert.equal(columns.length, 2);
        console.log(JSON.stringify({ schemaApplied: true, enabledSwitchesChanged: 0, messagesSent: 0 }));
    }
    const configs = (await db.query('SELECT c.*,p.name FROM chatbot_configs c JOIN pages p ON p.id=c.page_id ORDER BY c.page_id')).rows;
    assert.ok(configs.length, 'No configured Pages');
    const activeFirstDay = (await db.query(
        "SELECT count(*)::int AS clients FROM contacts c JOIN chatbot_configs b ON b.page_id=c.page_id JOIN chatbot_contact_states s ON s.contact_id=c.id AND s.page_id=c.page_id WHERE c.first_interaction_at > now()-interval '24 hours' AND s.status='active' AND b.enabled AND b.follow_up_enabled"
    )).rows[0].clients;
    const plan = { at: new Date().toISOString(), mode: activate ? 'activate' : applySchema ? 'schema' : 'preview',
        settings: FIRST_DAY_TIMING, configuredPages: configs.map(c => ({ pageId: c.page_id, name: c.name.trim(), enabled: c.enabled,
            followUpEnabled: c.follow_up_enabled, currentTimingMode: c.follow_up_first_day_mode || 'fixed' })),
        activeFirstDayClients: activeFirstDay, noFixedMessageCountCap: true, messagesSent: 0 };
    await writeFile(new URL('first-day-timing-plan-2026-10-22.json', out), JSON.stringify(plan, null, 2));
    console.log(JSON.stringify(plan));
    if (activate) {
        assert.ok(configs.every(c => c.follow_up_first_day_mode), 'Apply schema and deploy application first');
        await db.query('BEGIN');
        try {
            await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
            // Existing claims finish under the previous policy; do not interfere
            // with an in-flight customer delivery.
            const lockedConfigs = (await db.query('SELECT * FROM chatbot_configs ORDER BY page_id FOR UPDATE')).rows;
            const jobsBefore = (await db.query(
                "SELECT j.* FROM chatbot_follow_up_jobs j WHERE j.status IN ('pending','processing','ready_manual') FOR UPDATE OF j"
            )).rows;
            const switches = lockedConfigs.map(c => ({ page_id: c.page_id, enabled: c.enabled, follow_up_enabled: c.follow_up_enabled,
                trial_mode_enabled: c.trial_mode_enabled, trial_contact_id: c.trial_contact_id,
                follow_up_quick_delays_minutes: c.follow_up_quick_delays_minutes, follow_up_best_time_days: c.follow_up_best_time_days }));
            const backup = new URL('first-day-timing-backup-' + Date.now() + '.json', out);
            await writeFile(backup, JSON.stringify({ at: new Date().toISOString(), configs: lockedConfigs, jobs: jobsBefore }, null, 2), { flag: 'wx' });
            await db.query("UPDATE chatbot_configs SET follow_up_first_day_mode='adaptive',updated_at=clock_timestamp() WHERE follow_up_first_day_mode<>'adaptive'");
            // The existing config trigger increments policy_revision on every
            // setting change. Carry untouched queued jobs to that new revision
            // so the first-day switch cannot invalidate day 2-7 reminders.
            let existingJobsRebased = 0;
            for (const previousConfig of lockedConfigs) {
                if (previousConfig.follow_up_first_day_mode === 'adaptive') continue;
                const rebased = await db.query(
                    "UPDATE chatbot_follow_up_jobs j SET policy_revision=c.policy_revision,updated_at=clock_timestamp() FROM chatbot_configs c WHERE c.page_id=j.page_id AND j.page_id=$1 AND j.policy_revision=$2 AND j.status IN ('pending','ready_manual')",
                    [previousConfig.page_id, previousConfig.policy_revision]
                );
                existingJobsRebased += rebased.rowCount;
            }
            const now = new Date();
            const contacts = (await db.query(
                "SELECT c.id,c.page_id,c.first_interaction_at,c.last_inbound_at,c.last_interaction_at,s.last_bot_reply_at,s.automation_epoch,b.policy_revision FROM contacts c JOIN chatbot_configs b ON b.page_id=c.page_id JOIN chatbot_contact_states s ON s.contact_id=c.id AND s.page_id=c.page_id WHERE b.enabled AND b.follow_up_enabled AND (NOT b.trial_mode_enabled OR b.trial_contact_id=c.id) AND s.status='active' AND c.first_interaction_at>$1::timestamptz-interval '24 hours' AND c.first_interaction_at<$1 AND c.last_inbound_at=c.first_interaction_at AND s.last_bot_reply_at>=c.first_interaction_at AND NOT (c.pipeline_stage IN ('qualified','not_qualified','converted','order_created','opted_out') AND coalesce(c.pipeline_stage_source,'')<>'chatbot') FOR UPDATE OF s",
                [now.toISOString()]
            )).rows;
            const summary = { contactsConsidered: contacts.length, contactsScheduled: 0, jobsCreated: 0,
                skippedInFlightOrAlreadyMigrated: 0, pendingOldFirstDayJobsCancelled: 0 };
            for (const contact of contacts) {
                const existing = (await db.query(
                    "SELECT * FROM chatbot_follow_up_jobs WHERE page_id=$1 AND contact_id=$2 AND anchor_inbound_at=$3 AND schedule_type='response' ORDER BY sent_at NULLS LAST,sequence_index FOR UPDATE",
                    [contact.page_id, contact.id, contact.first_interaction_at]
                )).rows;
                if (existing.some(j => j.status === 'processing' || (j.message_id && j.status !== 'sent')) ||
                    existing.some(j => j.purpose === 'first_day_adaptive')) {
                    summary.skippedInFlightOrAlreadyMigrated++;
                    continue;
                }
                const sentTimes = [...new Set(existing.filter(j => j.status === 'sent' && j.message_id && j.sent_at).map(j => new Date(j.sent_at).getTime()))].sort((a,b) => a-b);
                const firstInquiry = new Date(contact.first_interaction_at).getTime();
                const initialReplyEnd = new Date(contact.last_bot_reply_at).getTime();
                const lastOutbound = Math.max(initialReplyEnd, ...sentTimes);
                const slots = buildFirstDaySchedule({ firstInquiry, initialReplyEnd, lastOutbound, now: now.getTime(), sentTimes });
                // No overdue send at activation: leave the normal worker a
                // one-minute pickup margin while keeping the original deadline.
                const futureSlots = slots.filter(slot => Date.parse(slot.dueAt) > now.getTime() + 60_000);
                const cancelled = await db.query(
                    "UPDATE chatbot_follow_up_jobs SET status='cancelled',cancelled_at=$4,claimed_at=NULL,error_message='Replaced by owner-approved original-first-day timing',updated_at=$4 WHERE page_id=$1 AND contact_id=$2 AND anchor_inbound_at=$3 AND schedule_type='response' AND purpose='scheduled' AND status='pending'",
                    [contact.page_id, contact.id, contact.first_interaction_at, now.toISOString()]
                );
                summary.pendingOldFirstDayJobsCancelled += cancelled.rowCount;
                // Filtering a due-now first slot would leave a missing predecessor.
                // Re-plan from the pickup margin instead of dropping that slot.
                const planned = slots.length && futureSlots.length !== slots.length
                    ? buildFirstDaySchedule({ firstInquiry, initialReplyEnd, lastOutbound, now: now.getTime() + 61_000, sentTimes })
                    : futureSlots;
                for (const slot of planned) {
                    const inserted = await db.query(
                        "INSERT INTO chatbot_follow_up_jobs(page_id,contact_id,anchor_inbound_at,schedule_type,sequence_index,due_at,message_text,status,purpose,automation_epoch,policy_revision,timing_context) VALUES($1,$2,$3,'response',$4,$5,'AI-generated from conversation at send time','pending','first_day_adaptive',$6,$7,$8::jsonb) ON CONFLICT(contact_id,anchor_inbound_at,schedule_type,sequence_index,automation_epoch,purpose) DO NOTHING RETURNING id",
                        [contact.page_id, contact.id, contact.first_interaction_at, slot.sequenceIndex, slot.dueAt,
                            contact.automation_epoch || 0, contact.policy_revision || 1,
                            JSON.stringify({ initial_reply_end: contact.last_bot_reply_at, carried_sent_times: sentTimes.map(time => new Date(time).toISOString()) })]
                    );
                    summary.jobsCreated += inserted.rowCount;
                }
                if (planned.length) summary.contactsScheduled++;
            }
            // Remove old fixed first-day jobs even for clients who have returned.
            const cancelledRest = await db.query(
                "UPDATE chatbot_follow_up_jobs j SET status='cancelled',cancelled_at=clock_timestamp(),claimed_at=NULL,error_message='Superseded first-day fixed timing',updated_at=clock_timestamp() FROM contacts c WHERE c.id=j.contact_id AND c.page_id=j.page_id AND c.first_interaction_at>now()-interval '24 hours' AND j.anchor_inbound_at< c.first_interaction_at+interval '24 hours' AND j.schedule_type='response' AND j.purpose='scheduled' AND j.status='pending'"
            );
            summary.pendingOldFirstDayJobsCancelled += cancelledRest.rowCount;
            const after = (await db.query('SELECT * FROM chatbot_configs ORDER BY page_id')).rows;
            assert.deepEqual(after.map(c => ({ page_id: c.page_id, enabled: c.enabled, follow_up_enabled: c.follow_up_enabled,
                trial_mode_enabled: c.trial_mode_enabled, trial_contact_id: c.trial_contact_id,
                follow_up_quick_delays_minutes: c.follow_up_quick_delays_minutes, follow_up_best_time_days: c.follow_up_best_time_days })), switches);
            assert.ok(after.every(c => c.follow_up_first_day_mode === 'adaptive'));
            await db.query('COMMIT');
            const receipt = { at: new Date().toISOString(), configuredPages: after.length, timingMode: 'adaptive',
                switchesPreserved: true, contactsReset: 0, messagesSentByRelease: 0, existingJobsRebased,
                backup: backup.pathname, ...summary };
            await writeFile(new URL('first-day-timing-activation-2026-10-22.json', out), JSON.stringify(receipt, null, 2));
            console.log(JSON.stringify(receipt));
        } catch (error) { await db.query('ROLLBACK'); throw error; }
    }
} finally { await db.end(); }
