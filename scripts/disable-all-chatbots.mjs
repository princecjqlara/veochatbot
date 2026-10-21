// Explicit owner request: disable every Page bot and its queued reminders.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import pg from 'pg';
const db=new pg.Client({connectionString:process.env.DATABASE_POOLER_URL_6543||process.env.DATABASE_POOLER_URL_5432||process.env.DATABASE_URL,
    ssl:{rejectUnauthorized:false},connectionTimeoutMillis:12000,query_timeout:25000});
await db.connect();
try {
    await db.query('BEGIN');
    try {
        await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='20s'");
        const configs=(await db.query('SELECT * FROM chatbot_configs ORDER BY page_id FOR UPDATE')).rows;
        const recovery=(await db.query('SELECT * FROM chatbot_inbound_recovery_pages ORDER BY page_id FOR UPDATE')).rows;
        const jobs=(await db.query("SELECT id,page_id,contact_id,status,cancelled_at,claimed_at,error_message,updated_at FROM chatbot_follow_up_jobs WHERE status IN ('pending','processing','ready_manual') FOR UPDATE")).rows;
        await writeFile(new URL(`../../data/all-bots-disabled-backup-${Date.now()}.json`,import.meta.url),JSON.stringify({at:new Date().toISOString(),configs,recovery,jobs},null,2),{flag:'wx'});
        const disabled=await db.query('UPDATE chatbot_configs SET enabled=false,updated_at=clock_timestamp() WHERE enabled=true RETURNING page_id');
        await db.query('UPDATE chatbot_inbound_recovery_pages SET enabled=false,lease_until=NULL WHERE enabled=true');
        const cancelled=await db.query("UPDATE chatbot_follow_up_jobs SET status='cancelled',cancelled_at=clock_timestamp(),claimed_at=NULL,error_message='Owner turned off bots on all Pages',updated_at=clock_timestamp() WHERE status IN ('pending','processing','ready_manual') RETURNING id");
        const remaining=(await db.query('SELECT count(*)::integer AS count FROM chatbot_configs WHERE enabled=true')).rows[0].count;
        const remainingRecovery=(await db.query('SELECT count(*)::integer AS count FROM chatbot_inbound_recovery_pages WHERE enabled=true')).rows[0].count;
        assert.equal(remaining,0);assert.equal(remainingRecovery,0);
        await db.query('COMMIT');
        console.log(JSON.stringify({configured:configs.length,newlyDisabled:disabled.rowCount,botsEnabled:remaining,recoveryEnabled:remainingRecovery,remindersCancelled:cancelled.rowCount,customerMessagesSent:0}));
    } catch(error){await db.query('ROLLBACK');throw error;}
    const pages=(await db.query('SELECT p.name,c.enabled,c.follow_up_enabled FROM chatbot_configs c JOIN pages p ON p.id=c.page_id ORDER BY p.name')).rows;
    console.log(JSON.stringify({readBack:pages}));
} finally {await db.end();}
