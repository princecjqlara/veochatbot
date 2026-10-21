// Read-only timestamp and policy metadata; no message text or contact identity output.
import pg from 'pg';
const db=new pg.Client({connectionString:process.env.DATABASE_POOLER_URL_6543,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:10000,query_timeout:15000});
await db.connect();
try {
    const rows=(await db.query(`SELECT r.status,r.error_message,r.updated_at AS reply_updated_at,r.inbound_at AS reply_inbound_at,
        c.last_inbound_at AS contact_last_inbound_at,s.last_inbound_at AS state_last_inbound_at,s.status AS state_status,
        s.stop_reason,s.automation_epoch,s.policy_revision AS state_policy_revision,cfg.policy_revision AS current_policy_revision,
        cfg.enabled,c.pipeline_stage,c.pipeline_stage_source
        FROM chatbot_reply_events r JOIN contacts c ON c.id=r.contact_id AND c.page_id=r.page_id
        LEFT JOIN chatbot_contact_states s ON s.contact_id=r.contact_id AND s.page_id=r.page_id
        JOIN chatbot_configs cfg ON cfg.page_id=r.page_id WHERE r.page_id=$1 ORDER BY r.created_at DESC LIMIT 1`,['776b33f3-e492-43bd-a887-d451d7faa5a8'])).rows;
    console.log(JSON.stringify({metadata:rows}));
    console.log(JSON.stringify({switches:(await db.query('SELECT count(*) FILTER(WHERE enabled)::integer AS bots_enabled,count(*)::integer AS configured FROM chatbot_configs')).rows[0],
        recoveryEnabled:(await db.query('SELECT count(*)::integer AS count FROM chatbot_inbound_recovery_pages WHERE enabled')).rows[0],
        reminderQueue:(await db.query("SELECT count(*)::integer AS count FROM chatbot_follow_up_jobs WHERE status IN ('pending','processing','ready_manual')")).rows[0]}));
} finally {await db.end();}
