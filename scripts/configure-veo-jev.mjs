import fs from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
const launch = JSON.parse(fs.readFileSync('.vercel/workspace-launch-receipt.json', 'utf8'));
const activate = process.argv.includes('--activate-model');
const position = Math.max(process.argv.indexOf('--model'), process.argv.indexOf('--activate-model'));
const model = position >= 0 ? process.argv[position + 1]?.trim() : null;
if (position >= 0 && !model) throw Error('Supply the exact Jev OpenRouter model or preset ID');
assert.equal(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname, 'vhtbmdizugnxkgocmruq.supabase.co');
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 20000 });
db.on('error', () => {});
try {
    await db.connect();
    if (model) {
        assert(process.env.OPENROUTER_API_KEY, 'OpenRouter must already be configured');
        const probe = await fetch('https://openrouter.ai/api/alpha/decisions', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, state: { status: 'human_response_pending', context: 'A human editor promised to send a price shortly. The customer is waiting.' }, questions: { continuation: { type: 'choice',
                instructions: 'Should the chatbot wait for the human editor or resume automatically?', criteria: { wait: 'The editor has not sent the promised price. Keep automation paused.', resume: 'The editor sent the promised price and the human conversation has ended.' } } } }) });
        if (!probe.ok) throw Error('The specified Jev model did not pass the OpenRouter Decisions API check');
        const result = await probe.json();assert.equal(result.answers?.continuation?.choice, 'wait', 'Jev must preserve an ongoing human conversation');
        await db.query('UPDATE veo_jev_policy SET model_id=$1,mode=$2,enabled=true,activated_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=$3', [model, activate ? 'active' : 'observe', launch.id]);
    }
    console.log(JSON.stringify((await db.query('SELECT enabled,model_id,mode,quiet_minutes,activated_at FROM veo_jev_policy WHERE tenant_id=$1', [launch.id])).rows[0]));
} finally { await db.end().catch(() => {}); }
