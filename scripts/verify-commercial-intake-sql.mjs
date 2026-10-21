// Execute the real migrations and RPCs in a transaction-local scratch schema.
// Always ROLLBACK. No public table, configuration, or customer message is changed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

// Match Next's local environment without printing credentials.
try {
    const env = await readFile(new URL('../.env.local', import.meta.url), 'utf8');
    for (const line of env.split(/\r?\n/)) {
        const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
} catch { /* Environment may already be injected. */ }
const connectionString = process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL;
if (!connectionString) throw new Error('An isolated verification connection is required');
const concurrent = process.argv.includes('--concurrency');
const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 3, connectionTimeoutMillis: 15000 });
const client = await pool.connect();
const schema = `intake_verify_${randomUUID().replaceAll('-', '')}`;
const rewrite = source => source.replace(/^BEGIN;\s*$/mg, '').replace(/^COMMIT;\s*$/mg, '')
    .replace(/\bpublic\./g, `${schema}.`).replace(/\bapp_private\./g, `${schema}.`)
    .replace(/search_path\s*=\s*public\s*,\s*pg_temp/gi, `search_path=${schema},pg_temp`);
const checks = [];
const check = (value, message) => { assert.ok(value, message); checks.push(message); };
const when = '2026-10-16T15:59:00.000Z';
const form = { 'Business Name': 'Bakery', 'Business Location': 'Manila', 'Goal ng video': 'Sell cakes', 'Contact Number': '09171234567' };
try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='30s'");
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path=${schema},pg_temp`);
    // Minimal baseline reproduces the real column/constraint contracts, then
    // executes the unmodified legacy migration before the additive migration.
    await client.query(`
        CREATE TABLE pages(id uuid PRIMARY KEY);
        CREATE TABLE contacts(id uuid PRIMARY KEY,page_id uuid REFERENCES pages(id),psid text,
            pipeline_stage text NOT NULL DEFAULT 'engaged',pipeline_stage_source text NOT NULL DEFAULT 'system',
            pipeline_stage_updated_at timestamptz NOT NULL DEFAULT now(),last_inbound_at timestamptz,best_contact_hour integer);
        CREATE TABLE chatbot_configs(page_id uuid PRIMARY KEY REFERENCES pages(id),enabled boolean NOT NULL DEFAULT false,
            follow_up_enabled boolean NOT NULL DEFAULT true,trial_mode_enabled boolean NOT NULL DEFAULT false,trial_contact_id uuid,
            details_to_collect jsonb NOT NULL DEFAULT '[]',follow_up_quick_delays_minutes jsonb NOT NULL DEFAULT '[10,60,120]',
            follow_up_best_time_days jsonb NOT NULL DEFAULT '[2,3]',updated_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE chatbot_contact_states(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),page_id uuid REFERENCES pages(id),contact_id uuid REFERENCES contacts(id),
            status text NOT NULL DEFAULT 'active',started_at timestamptz NOT NULL DEFAULT now(),window_expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
            collected_details jsonb NOT NULL DEFAULT '{}',missing_details jsonb NOT NULL DEFAULT '[]',stop_reason text,stopped_at timestamptz,
            last_inbound_at timestamptz,last_bot_reply_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(page_id,contact_id));
        CREATE TABLE chatbot_follow_up_jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),page_id uuid REFERENCES pages(id),contact_id uuid REFERENCES contacts(id),
            anchor_inbound_at timestamptz NOT NULL,schedule_type text NOT NULL,sequence_index integer NOT NULL,due_at timestamptz NOT NULL,
            message_text text NOT NULL,status text NOT NULL DEFAULT 'pending',cancelled_at timestamptz,claimed_at timestamptz,error_message text,
            UNIQUE(contact_id,anchor_inbound_at,schedule_type,sequence_index));
        CREATE TABLE schema_migrations(version text PRIMARY KEY,description text);
    `);
    await client.query(rewrite(await readFile(new URL('../supabase/migrations/202610150001_chatbot_continuation_reviews.sql', import.meta.url), 'utf8')));
    await client.query(rewrite(await readFile(new URL('../supabase/migrations/202610170001_commercial_video_nightly_handoff.sql', import.meta.url), 'utf8')));
    await client.query(rewrite(await readFile(new URL('../supabase/migrations/202610210001_nightly_review_requires_no_agreement.sql', import.meta.url), 'utf8')));
    check(Number((await client.query("SELECT count(*) FROM pg_constraint WHERE conrelid=$1::regclass AND contype='u' AND cardinality(conkey)=4", [`${schema}.chatbot_follow_up_jobs`])).rows[0].count) === 1,
        'additive schema preserves old reminder uniqueness until application deployment');
    // Simulate the transactional activation step, after new application deployment.
    await client.query(`DO $$ DECLARE item record; BEGIN
        FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='${schema}.chatbot_follow_up_jobs'::regclass
            AND contype='u' AND cardinality(conkey)=4 LOOP
            EXECUTE format('ALTER TABLE ${schema}.chatbot_follow_up_jobs DROP CONSTRAINT %I', item.conname);
        END LOOP; END $$`);
    // Allow deterministic historical fixtures without pretending that a newly
    // activated production configuration had already been enabled yesterday.
    await client.query('ALTER TABLE chatbot_configs DISABLE TRIGGER chatbot_continuation_activation');
    const due = async value => (await client.query(`SELECT ${schema}.chatbot_nightly_due_at($1)::text AS due`, [value])).rows[0].due;
    for (const invalid of ['00000000000', 'call me 09171234567', 'pending']) {
        const missing = (await client.query(`SELECT ${schema}.chatbot_commercial_missing_details($1) AS missing`, [{ ...form, 'Contact Number': invalid }])).rows[0].missing;
        check(missing.includes('Contact Number'), `SQL rejects unusable phone ${invalid}`);
    }
    check(Date.parse(await due('2026-10-16T15:58:59Z')) === Date.parse(when), '23:58:59 PH is due today at 23:59');
    check(Date.parse(await due(when)) === Date.parse('2026-10-17T15:59:00Z'), '23:59:00 takeover is due next day');
    check(Date.parse(await due('2026-12-31T15:59:59Z')) === Date.parse('2027-01-01T15:59:00Z'), 'year rollover preserves Philippine cutoff');

    async function fixture({ complete = false, request = false, stage = 'engaged', pause = 'human_takeover', inbound = '2026-10-16T15:00:00Z' } = {}) {
        const page = randomUUID(), contact = randomUUID();
        await client.query('INSERT INTO pages(id) VALUES($1)', [page]);
        await client.query(`INSERT INTO chatbot_configs(page_id,enabled,commercial_video_intake_enabled,continuation_review_enabled,
            continuation_enabled_at,continuation_review_hour,continuation_review_minute)
            VALUES($1,true,true,true,'2026-10-15T00:00:00Z',1,0)`, [page]);
        await client.query(`INSERT INTO contacts(id,page_id,psid,pipeline_stage,pipeline_stage_source,last_inbound_at)
            VALUES($1,$2,'scratch',$3,'manual',$4)`, [contact, page, stage, inbound]);
        await client.query(`INSERT INTO chatbot_contact_states(page_id,contact_id,status,started_at,window_expires_at,stop_reason,stopped_at,
            pause_kind,last_human_activity_at,automation_epoch,collected_details,has_clear_request,request_type,request_evidence)
            VALUES($1,$2,'stopped','2026-10-16T10:00:00Z','2026-10-23T10:00:00Z','manual','2026-10-16T15:10:00Z',$3,
                '2026-10-16T15:10:00Z',4,$4,$5,$6,$7)`, [page, contact, pause, complete ? form : { 'Business Name': 'Bakery' }, request,
            request ? 'free_concept' : null, request ? 'Please make a concept' : null]);
        return { page, contact };
    }
    async function snapshot(f) {
        // Preserve PostgreSQL microseconds in optimistic-concurrency tokens.
        // JavaScript Date conversion would truncate them and make every CAS fail.
        const state = await client.query('SELECT *,updated_at::text AS updated_at FROM chatbot_contact_states WHERE contact_id=$1', [f.contact]);
        const contact = await client.query('SELECT *,pipeline_stage_updated_at::text AS pipeline_stage_updated_at FROM contacts WHERE id=$1', [f.contact]);
        const config = await client.query('SELECT *,updated_at::text AS updated_at FROM chatbot_configs WHERE page_id=$1', [f.page]);
        const review = await client.query("SELECT * FROM chatbot_continuation_reviews WHERE contact_id=$1 AND status='processing' ORDER BY policy_revision DESC,created_at DESC LIMIT 1", [f.contact]);
        return { state: state.rows[0], contact: contact.rows[0], config: config.rows[0], review: review.rows[0] };
    }
    async function resume(snap, details, request = false) {
        const missing = (await client.query(`SELECT ${schema}.chatbot_commercial_missing_details($1) AS missing`, [details])).rows[0].missing;
        return (await client.query(`SELECT ${schema}.resume_chatbot_nightly_review($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) AS resumed`,
            [snap.review.id, snap.review.attempt_count, snap.state.updated_at, snap.contact.pipeline_stage_updated_at, snap.contact.last_inbound_at,
                snap.config.updated_at, snap.state.automation_epoch, snap.state.last_human_activity_at, details, JSON.stringify(missing),
                request ? 'free_concept' : null, request, request ? 'Please make a concept' : null, { history_verified: true }, when])).rows[0].resumed;
    }
    const fixtures = [];
    for (const complete of [false, true]) for (const request of [false, true]) fixtures.push({ ...await fixture({ complete, request }), complete, request });
    const before = await client.query(`SELECT * FROM ${schema}.claim_chatbot_continuation_reviews(100,'2026-10-16T15:58:59Z')`);
    check(before.rows.length === 0, 'reviews never claim early to approach a send-window limit');
    const claimed = await client.query(`SELECT * FROM ${schema}.claim_chatbot_continuation_reviews(100,$1)`, [when]);
    check(claimed.rows.length === 4, 'all four handoff truth-table cases claim at 23:59 PH');
    for (const f of fixtures) {
        const snap = await snapshot(f);
        const result = await resume(snap, f.complete ? form : { 'Business Name': 'Bakery' }, f.request);
        check(result === !f.request, `SQL nightly agreement guard: complete=${f.complete}, request=${f.request}`);
        if (result) {
            const jobs = (await client.query('SELECT * FROM chatbot_follow_up_jobs WHERE contact_id=$1', [f.contact])).rows;
            check(jobs.filter(job => job.purpose === 'nightly_continuation').length === 1, 'one immediate continuation per resumed episode');
            check(jobs.every(job => job.automation_epoch === 5 && Date.parse(job.anchor_inbound_at) === Date.parse('2026-10-16T15:00:00Z')), 'all replacement jobs preserve inbound anchor and new epoch');
            check(jobs.filter(job => job.purpose === 'scheduled').every(job => Date.parse(job.due_at) > Date.parse(when) + 60_000), 'elapsed and immediately overlapping scheduled slots are omitted');
            check(await resume(snap, f.complete ? form : { 'Business Name': 'Bakery' }, f.request) === false, 'replaying the same review cannot resume twice');
        }
    }
    check((await client.query(`SELECT * FROM ${schema}.claim_chatbot_continuation_reviews(100,$1)`, [when])).rows.length === 0, 'duplicate workers cannot claim already processing or completed reviews');
    const stale = await fixture();
    await client.query(`SELECT * FROM ${schema}.claim_chatbot_continuation_reviews(100,$1)`, [when]);
    const staleSnapshot = await snapshot(stale);
    await client.query("UPDATE chatbot_contact_states SET last_human_activity_at='2026-10-16T15:40:00Z' WHERE contact_id=$1", [stale.contact]);
    check(await resume(staleSnapshot, {}) === false, 'newer human activity invalidates an already reviewed snapshot');
    const stateAfterHuman = (await snapshot(stale)).state;
    check(stateAfterHuman.automation_epoch === 5, 'strictly newer human activity advances epoch once');
    await client.query("UPDATE chatbot_contact_states SET last_human_activity_at='2026-10-16T15:40:00Z' WHERE contact_id=$1", [stale.contact]);
    check((await snapshot(stale)).state.automation_epoch === 5, 'repeated scans of the same staff event are idempotent');

    for (const change of ['inbound', 'configuration', 'explicit_hold', 'pipeline', 'qualified']) {
        const f = await fixture();
        await client.query(`SELECT * FROM ${schema}.claim_chatbot_continuation_reviews(100,$1)`, [when]);
        const snap = await snapshot(f);
        if (change === 'inbound') await client.query("UPDATE contacts SET last_inbound_at='2026-10-16T15:30:00Z' WHERE id=$1", [f.contact]);
        if (change === 'configuration') await client.query('UPDATE chatbot_configs SET follow_up_enabled=false WHERE page_id=$1', [f.page]);
        if (change === 'explicit_hold') await client.query("UPDATE chatbot_contact_states SET pause_kind='explicit_hold' WHERE contact_id=$1", [f.contact]);
        if (change === 'pipeline') await client.query("UPDATE contacts SET pipeline_stage='converted' WHERE id=$1", [f.contact]);
        if (change === 'qualified') await client.query("UPDATE contacts SET pipeline_stage='qualified' WHERE id=$1", [f.contact]);
        check(await resume(snap, {}) === false, `${change} change prevents stale atomic resume`);
    }
    for (const stop of ['opt_out', 'refusal', 'not_qualified', 'converted', 'order_created']) {
        const f = await fixture();
        await client.query('UPDATE chatbot_contact_states SET stop_reason=$2 WHERE contact_id=$1', [f.contact, stop]);
        await client.query("UPDATE chatbot_contact_states SET status='active',stop_reason=NULL,pause_kind=NULL WHERE contact_id=$1", [f.contact]);
        check((await snapshot(f)).state.stop_reason === stop, `${stop} cannot be cleared by stale automation`);
    }
    const held = await fixture({ pause: 'explicit_hold' });
    await client.query("UPDATE chatbot_contact_states SET pause_kind='human_takeover',last_human_activity_at='2026-10-16T15:40:00Z' WHERE contact_id=$1", [held.contact]);
    check((await snapshot(held)).state.pause_kind === 'explicit_hold', 'ordinary staff activity cannot overwrite an explicit hold');
    for (const stop of ['manual', 'qualified', 'converted', 'order_created', 'not_qualified', 'opt_out']) {
        const f = await fixture();
        await client.query("UPDATE chatbot_contact_states SET status='active',stop_reason=NULL,pause_kind=NULL WHERE contact_id=$1", [f.contact]);
        await client.query("UPDATE chatbot_contact_states SET status='stopped',stop_reason=$2,pause_kind='explicit_hold',last_human_activity_at='2026-10-16T15:45:00Z' WHERE contact_id=$1", [f.contact, stop]);
        const state = (await snapshot(f)).state;
        check(state.pause_kind === 'explicit_hold' && state.stop_reason === stop,
            `new human activity preserves incoming ${stop} hold instead of downgrading it`);
    }
    const revision = await fixture();
    await client.query(`SELECT * FROM ${schema}.claim_chatbot_continuation_reviews(100,$1)`, [when]);
    const priorRevision = (await snapshot(revision)).config.policy_revision;
    await client.query("UPDATE chatbot_configs SET follow_up_quick_delays_minutes='[10]' WHERE page_id=$1", [revision.page]);
    const reclaims = (await client.query(`SELECT * FROM ${schema}.claim_chatbot_continuation_reviews(100,$1)`, [when])).rows;
    check(reclaims.some(row => row.contact_id === revision.contact && row.policy_revision > priorRevision), 'a settings revision creates a fresh eligible review instead of stranding the handoff');

    const config = (await snapshot(fixtures[0])).config;
    check(config.continuation_review_hour === 23 && config.continuation_review_minute === 59, 'database enforces scoped 23:59 schedule');
    const failedTransaction = await fixture();
    await client.query(`SELECT * FROM ${schema}.claim_chatbot_continuation_reviews(100,$1)`, [when]);
    const transactionSnapshot = await snapshot(failedTransaction);
    await client.query('SAVEPOINT rpc_atomicity');
    check(await resume(transactionSnapshot, {}) === true, 'atomicity fixture resumes');
    await client.query('ROLLBACK TO SAVEPOINT rpc_atomicity');
    check((await snapshot(failedTransaction)).state.status === 'stopped' &&
        Number((await client.query('SELECT count(*) FROM chatbot_follow_up_jobs WHERE contact_id=$1', [failedTransaction.contact])).rows[0].count) === 0,
    'rolling back resume restores both ownership and jobs');
    if (concurrent) {
        const target = await fixture();
        await client.query('COMMIT');
        const claim = async () => {
            const connection = await pool.connect();
            try {
                await connection.query('BEGIN');
                await connection.query("SET LOCAL statement_timeout='20s'");
                const claimed = (await connection.query(`SELECT * FROM ${schema}.claim_chatbot_continuation_reviews(100,$1)`, [when])).rows;
                await connection.query('COMMIT');
                return claimed;
            } catch (error) { await connection.query('ROLLBACK'); throw error; }
            finally { connection.release(); }
        };
        const [a, b] = await Promise.all([claim(), claim()]);
        check(!a.some(row => b.some(other => other.id === row.id)), 'two simultaneous PostgreSQL workers never claim the same review');
        check([...a, ...b].filter(row => row.contact_id === target.contact).length === 1, 'a newly due episode is claimed exactly once across concurrent connections');
    }
    console.log(JSON.stringify({ checks: checks.length, passed: checks, verification: concurrent
        ? 'Real PostgreSQL, isolated scratch schema, concurrent connections; scratch schema removed in finally'
        : 'Real PostgreSQL, transaction-local scratch schema; always rolled back' }, null, 2));
} finally {
    await client.query('ROLLBACK');
    if (concurrent) {
        if (!/^intake_verify_[a-f0-9]{32}$/.test(schema)) throw new Error('Invalid scratch cleanup target');
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
    client.release();
    await pool.end();
}
