import fs from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
const launch = JSON.parse(fs.readFileSync('.vercel/workspace-launch-receipt.json', 'utf8'));
const position = process.argv.indexOf('--model');
const model = position >= 0 ? process.argv[position + 1]?.trim() : null;
if (position >= 0 && !model) throw Error('Supply the exact Jev OpenRouter model or preset ID');
assert.equal(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname, 'vhtbmdizugnxkgocmruq.supabase.co');
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 20000 });
db.on('error', () => {});
try {
    await db.connect();
    if (model) {
        assert(process.env.OPENROUTER_API_KEY, 'OpenRouter must already be configured');
        const probe = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
            headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, max_tokens: 40, temperature: 0, provider: { require_parameters: true }, messages: [{ role: 'user', content: 'Configuration check only. Return the JSON object {"ok":true}.' }],
                response_format: { type: 'json_schema', json_schema: { name: 'configuration_check', strict: true, schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] } } } }) });
        if (!probe.ok) throw Error('The specified Jev model did not pass the OpenRouter structured-output check');
        const result = await probe.json();assert.equal(JSON.parse(result.choices?.[0]?.message?.content || '{}').ok, true, 'The model did not return the required structured response');
        await db.query('UPDATE veo_jev_policy SET model_id=$1,enabled=true,activated_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=$2', [model, launch.id]);
    }
    console.log(JSON.stringify((await db.query('SELECT enabled,model_id,quiet_minutes,activated_at FROM veo_jev_policy WHERE tenant_id=$1', [launch.id])).rows[0]));
} finally { await db.end().catch(() => {}); }
