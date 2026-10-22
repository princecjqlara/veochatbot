// Real SQL in a unique scratch schema; all changes roll back and no messages are sent.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
const timing = await import('../src/lib/chatbot-follow-up-timing.ts');
const { getBestTimeFollowUpDueAt } = timing.getBestTimeFollowUpDueAt ? timing : timing.default;
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_6543 || process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 30000 });
await db.connect();
try {
    await db.query("BEGIN; SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s'");
    const schema = 'pricing_days_verify_' + Date.now();
    const t = name => schema + '.' + name;
    await db.query(`CREATE SCHEMA ${schema};
        CREATE TABLE ${t('pages')}(id uuid PRIMARY KEY);
        CREATE TABLE ${t('contacts')}(id uuid PRIMARY KEY,page_id uuid REFERENCES ${t('pages')}(id),
            first_interaction_at timestamptz DEFAULT now(),last_inbound_at timestamptz DEFAULT now(),
            pipeline_stage text DEFAULT 'engaged',pipeline_stage_source text DEFAULT 'chatbot');
        CREATE TABLE ${t('tags')}(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text,color text,owner_type text,owner_id uuid,page_id uuid,is_default boolean,system_key text);
        CREATE TABLE ${t('contact_tags')}(contact_id uuid REFERENCES ${t('contacts')}(id),tag_id uuid REFERENCES ${t('tags')}(id),UNIQUE(contact_id,tag_id));
        CREATE TABLE ${t('schema_migrations')}(version text PRIMARY KEY,description text);
        CREATE TABLE ${t('chatbot_configs')}(page_id uuid PRIMARY KEY,enabled boolean DEFAULT true,follow_up_enabled boolean DEFAULT true,trial_mode_enabled boolean DEFAULT false,trial_contact_id uuid);
        CREATE TABLE ${t('chatbot_contact_states')}(page_id uuid,contact_id uuid,status text,PRIMARY KEY(page_id,contact_id));
        CREATE TABLE ${t('chatbot_follow_up_jobs')}(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),page_id uuid,contact_id uuid,
            anchor_inbound_at timestamptz,schedule_type text,sequence_index integer,due_at timestamptz,message_text text,status text,purpose text,
            automation_epoch integer,policy_revision integer,error_message text,
            UNIQUE(contact_id,anchor_inbound_at,schedule_type,sequence_index,automation_epoch,purpose));`);
    const load = async file => (await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'))
        .replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '').replaceAll('public.', schema + '.')
        .replaceAll('app_private.schema_migrations', t('schema_migrations'));
    await db.query(await load('202610220002_chatbot_pricing_experiments.sql'));
    const upgrade = await load('202610220003_chatbot_pricing_day_sequence.sql');
    await db.query(upgrade);
    await db.query(upgrade);
    const formulaUpgrade = await load('202610220004_chatbot_pricing_best_time_sequence.sql');
    await db.query(formulaUpgrade);
    await db.query(formulaUpgrade);
    const page = randomUUID(), contact = randomUUID();
    await db.query(`INSERT INTO ${t('pages')} VALUES($1);`, [page]);
    await db.query(`INSERT INTO ${t('chatbot_configs')}(page_id) VALUES($1)`, [page]);
    const config = { name: 'Daily test',mode: 'sequence',duration_seconds: 24,follow_up_gap_minutes: 120,attribution_days: 7,minimum_sample: 100,
        packages: ['A','B','C','D'].map((name,i) => ({name,price: 600+i*100,message: 'Approved package'})) };
    const run = (await db.query(`SELECT ${t('create_chatbot_pricing_experiment')}($1,$2) id`, [page,config])).rows[0].id;
    await db.query(`INSERT INTO ${t('contacts')}(id,page_id) VALUES($1,$2)`, [contact,page]);
    const anchor = async () => (await db.query(`SELECT last_inbound_at::text FROM ${t('contacts')} WHERE id=$1`,[contact])).rows[0].last_inbound_at;
    const reserve = async (key,follow = true) => (await db.query(`SELECT ${t('reserve_chatbot_pricing_offer')}($1,$2,$3,$4,true,24) offer`,[page,contact,key,follow])).rows[0].offer;
    const active = async offer => (await db.query(`SELECT ${t('chatbot_pricing_offer_is_active')}($1) active`,[offer.delivery_id])).rows[0].active;
    const finish = offer => db.query(`SELECT ${t('finish_chatbot_pricing_delivery')}($1,$2)`,[offer.delivery_id,randomUUID()]);
    const schedule = async (days = [2,3,5,7], hour = 12) => (await db.query(`SELECT ${t('schedule_chatbot_pricing_promotion')}($1,$2,$3,$4,$5,3,2) plan`,[page,contact,await anchor(),days,hour])).rows[0].plan;
    const first = await reserve('initial',false);
    assert.ok(first);
    await finish(first);
    assert.equal(await reserve('early'),null);
    const plan = await schedule([]);
    assert.equal(plan.scheduled,1);
    assert.equal(plan.waiting_response,true,'A cold later-day offer waits instead of using HUMAN_AGENT');
    assert.ok([2,3,5,7].includes(plan.day));
    assert.equal(new Date(plan.due_at).toISOString(),getBestTimeFollowUpDueAt(new Date(await anchor()),plan.day,12),'SQL uses the exact existing later-day formula');
    assert.equal((await schedule()).scheduled,0,'Repeated scheduling cannot duplicate the next promotion');
    assert.equal((await db.query(`SELECT due_at>=now()+interval '24 hours' valid FROM ${t('chatbot_follow_up_jobs')}`)).rows[0].valid,true);
    const dueJob = async index => {
        await db.query(`INSERT INTO ${t('chatbot_follow_up_jobs')}(page_id,contact_id,anchor_inbound_at,schedule_type,sequence_index,due_at,status,purpose,automation_epoch,policy_revision)
            VALUES($1,$2,$3,'response',$4,now()-interval '1 minute','processing','pricing_promotion',3,2)
            ON CONFLICT(contact_id,anchor_inbound_at,schedule_type,sequence_index,automation_epoch,purpose)
            DO UPDATE SET due_at=EXCLUDED.due_at,status='processing'`,[page,contact,await anchor(),index]);
        const job=(await db.query(`SELECT id FROM ${t('chatbot_follow_up_jobs')} WHERE contact_id=$1 AND sequence_index=$2`,[contact,index])).rows[0];
        return 'follow-up:'+job.id;
    };
    const secondKey=await dueJob(0);
    for (const age of ['3 hours','23 hours 59 minutes']) {
        await db.query(`UPDATE ${t('chatbot_pricing_assignments')} SET first_exposed_at=now()-$1::interval WHERE id=$2`,[age,first.assignment_id]);
        assert.equal(await reserve(secondKey),null,'First package must last the full 24 hours even when a job is due');
    }
    await db.query(`UPDATE ${t('chatbot_pricing_assignments')} SET first_exposed_at=now()-interval '24 hours' WHERE id=$1`,[first.assignment_id]);
    const second=await reserve(secondKey);
    assert.ok(second);
    assert.notEqual(second.package_id,first.package_id);
    assert.equal(await active(second),true);
    await db.query(`UPDATE ${t('chatbot_pricing_assignments')} SET first_exposed_at=now()-interval '23 hours' WHERE id=$1`,[first.assignment_id]);
    assert.equal(await active(second),false,'The initial hold is rechecked before delivery');
    await db.query(`UPDATE ${t('chatbot_pricing_assignments')} SET first_exposed_at=now()-interval '2 days' WHERE id=$1`,[first.assignment_id]);
    await finish(second);
    assert.equal(await reserve('unscheduled-promotion'),null,'An arbitrary source cannot bypass the best-time schedule');
    const bestHour=(await db.query("SELECT extract(hour from now() AT TIME ZONE 'Asia/Manila')::int AS best_hour")).rows[0].best_hour;
    const next=await schedule([2,3,5,7],bestHour);
    assert.equal(next.day,2);
    assert.equal(new Date(next.due_at).toISOString(),getBestTimeFollowUpDueAt(new Date(await anchor()),2,bestHour));
    const clock=(await db.query('SELECT now() clock')).rows[0].clock;
    assert.ok(new Date(next.due_at)-clock<24*60*60*1000,'A scheduled opportunity is not pushed to 24 hours after the last delivery');
    const nextJob=(await db.query(`SELECT id FROM ${t('chatbot_follow_up_jobs')} WHERE contact_id=$1 AND sequence_index=1`,[contact])).rows[0];
    assert.equal(await reserve('follow-up:'+nextJob.id),null,'A future opportunity cannot send early');
    const third=await reserve(await dueJob(1));
    assert.ok(third,'A due opportunity is eligible without an added 24-hour gap');
    assert.ok(![first.package_id,second.package_id].includes(third.package_id));
    await db.query(`UPDATE ${t('chatbot_follow_up_jobs')} SET status='cancelled' WHERE id=$1`,[nextJob.id]);
    assert.equal(await active(third),false,'Cancellation stops a reserved opportunity');
    await db.query(`UPDATE ${t('chatbot_follow_up_jobs')} SET status='processing' WHERE id=$1`,[nextJob.id]);
    await finish(third);
    await db.query(`UPDATE ${t('chatbot_configs')} SET enabled=false WHERE page_id=$1`,[page]);
    assert.equal((await schedule()).scheduled,0);
    await db.query(`UPDATE ${t('chatbot_configs')} SET enabled=true,trial_mode_enabled=true,trial_contact_id=NULL WHERE page_id=$1`,[page]);
    assert.equal((await schedule()).scheduled,0);
    await db.query(`UPDATE ${t('chatbot_configs')} SET trial_mode_enabled=false WHERE page_id=$1`,[page]);
    const last=await reserve(await dueJob(2));
    assert.ok(last);
    await finish(last);
    assert.equal((await schedule()).scheduled,0,'A completed four-package sequence stops');
    assert.equal((await db.query(`SELECT count(*)::int n FROM ${t('chatbot_pricing_deliveries')} WHERE status='sent'`)).rows[0].n,4);
    assert.equal((await db.query(`SELECT id FROM ${t('chatbot_pricing_experiments')} WHERE status='active'`)).rows[0].id,run,'Timing changes preserve runs');
    const privileges = (await db.query(`SELECT has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') member
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname='schedule_chatbot_pricing_promotion'`,[schema])).rows[0];
    assert.deepEqual(privileges,{anon:false,member:false});
    await db.query('ROLLBACK');
    console.log(JSON.stringify({passed:true,idempotentMigration:true,first24HoursOneCatalog:true,existingBestTimeFormula:true,noFixedGap:true,onlyDueOpportunities:true,coldPromotionsHeld:true,noMessagesSent:true}));
} finally { await db.query('ROLLBACK').catch(()=>{}); await db.end(); }
