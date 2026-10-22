// Exercises the real SQL in an isolated schema inside a rolled-back transaction.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const connectionString = process.env.DATABASE_POOLER_URL_6543 || process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL;
assert.ok(connectionString, 'Set DATABASE_URL or a DATABASE_POOLER_URL before running the SQL verification');
const db = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 30000 });
await db.connect();
try {
    await db.query('BEGIN');
    await db.query("SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s'");
    const schema = 'pricing_verify_' + Date.now();
    const table = name => schema + '.' + name;
    await db.query('CREATE SCHEMA ' + schema);
    await db.query(`CREATE TABLE ${table('pages')} (id uuid PRIMARY KEY);
        CREATE TABLE ${table('contacts')} (id uuid PRIMARY KEY, page_id uuid NOT NULL REFERENCES ${table('pages')}(id),
            last_inbound_at timestamptz DEFAULT now(), first_interaction_at timestamptz DEFAULT now(), pipeline_stage text DEFAULT 'engaged', pipeline_stage_source text DEFAULT 'chatbot');
        CREATE TABLE ${table('tags')} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, color text,
            owner_type text, owner_id uuid, page_id uuid, is_default boolean, system_key text);
        CREATE TABLE ${table('contact_tags')} (contact_id uuid REFERENCES ${table('contacts')}(id), tag_id uuid REFERENCES ${table('tags')}(id),
            UNIQUE(contact_id,tag_id));
        CREATE TABLE ${table('schema_migrations')} (version text PRIMARY KEY, description text);`);
    const source = await readFile(new URL('../supabase/migrations/202610220002_chatbot_pricing_experiments.sql', import.meta.url), 'utf8');
    const migration = source.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '')
        .replaceAll('public.', schema + '.').replaceAll('app_private.schema_migrations', table('schema_migrations'));
    await db.query(migration);
    await db.query(migration);
    const pageId = randomUUID(), otherPageId = randomUUID();
    await db.query(`INSERT INTO ${table('pages')} VALUES ($1), ($2)`, [pageId, otherPageId]);
    const config = { name: 'Scratch fair test', mode: 'fair_test_sequence', duration_seconds: 24,
        follow_up_gap_minutes: 120, attribution_days: 7, minimum_sample: 100,
        packages: [{ name: 'A', price: 600, message: 'Includes a commercial.' },
            { name: 'B', price: 700, message: 'Includes a poster.' }, { name: 'C', price: 800, message: 'Includes a caption.' }] };
    const createRun = async (changes = {}, target = pageId) => (await db.query(`SELECT ${table('create_chatbot_pricing_experiment')}($1,$2) AS id`, [target, { ...config, ...changes }])).rows[0].id;
    const runId = await createRun();
    const newContact = async (target = pageId) => {
        const id = randomUUID();
        await db.query(`INSERT INTO ${table('contacts')}(id,page_id) VALUES($1,$2)`, [id, target]);
        return id;
    };
    const reserve = async (contactId, sourceKey, followUp = false, eligible = true, duration = 24, target = pageId) =>
        (await db.query(`SELECT ${table('reserve_chatbot_pricing_offer')}($1,$2,$3,$4,$5,$6) AS offer`,
            [target, contactId, sourceKey, followUp, eligible, duration])).rows[0].offer;
    const finish = (offer, messageId = randomUUID()) => db.query(`SELECT ${table('finish_chatbot_pricing_delivery')}($1,$2)`, [offer.delivery_id, messageId]);
    const release = offer => db.query(`SELECT ${table('release_chatbot_pricing_offer')}($1)`, [offer.delivery_id]);
    const analytics = async (target = pageId, id = runId) =>
        (await db.query(`SELECT ${table('get_chatbot_pricing_analytics')}($1,$2) AS metrics`, [target, id])).rows[0].metrics;
    const eligibleContact = await newContact();
    assert.equal(await reserve(eligibleContact, 'wrong-duration', false, true, 30), null);
    assert.equal(await reserve(eligibleContact, 'no-quote', false, false), null);
    assert.equal(await reserve(await newContact(otherPageId), 'foreign-contact'), null);
    const previousInquiry = await newContact();
    await db.query(`UPDATE ${table('contacts')} SET first_interaction_at=now()-interval '1 day' WHERE id=$1`, [previousInquiry]);
    assert.equal(await reserve(previousInquiry, 'existing-inquiry'), null, 'New runs do not change existing customer prices');
    const cohorts = [];
    for (let index = 0; index < 30; index++) {
        const contactId = await newContact();
        const offer = await reserve(contactId, 'quote');
        assert.ok(offer);
        const retry = await reserve(contactId, 'quote');
        assert.equal(retry.delivery_id, offer.delivery_id);
        assert.equal(retry.package_id, offer.package_id);
        assert.equal((await reserve(contactId, 'parallel-job', true)).blocked, true, 'An in-flight offer blocks another source');
        assert.equal((await db.query(`SELECT ${table('begin_chatbot_pricing_delivery')}($1) AS begun`, [offer.delivery_id])).rows[0].begun, true);
        assert.equal((await reserve(contactId, 'quote')).blocked, true, 'A network send in progress cannot be replayed');
        await finish(offer);
        await finish(offer, 'duplicate-ack');
        assert.equal((await reserve(contactId, 'quote')).blocked, true, 'Sent sources cannot be replayed');
        cohorts.push({ contactId, offer });
    }
    assert.deepEqual((await analytics()).map(row => row.assigned), [10, 10, 10], 'Least-assigned allocation stays exactly balanced');
    assert.deepEqual((await analytics()).map(row => row.exposed), [10, 10, 10]);
    assert.equal((await db.query(`SELECT count(*)::int n FROM ${table('contact_tags')}`)).rows[0].n, 30, 'Package tags are applied once on delivery');
    assert.equal((await db.query(`SELECT count(*)::int n FROM ${table('chatbot_pricing_outcomes')}`)).rows[0].n, 0, 'Package tags do not imply conversion');

    const customer = cohorts[0];
    assert.equal(await reserve(customer.contactId, 'too-soon', true), null);
    await db.query(`UPDATE ${table('chatbot_pricing_deliveries')} SET sent_at=now()-interval '3 hours' WHERE assignment_id=$1`, [customer.offer.assignment_id]);
    const promo = await reserve(customer.contactId, 'follow-up-1', true, false);
    assert.ok(promo);
    assert.equal(promo.kind, 'promotion');
    assert.notEqual(promo.package_id, customer.offer.package_id);
    await finish(promo);
    await db.query(`UPDATE ${table('chatbot_pricing_deliveries')} SET sent_at=now()-interval '3 hours' WHERE assignment_id=$1`, [customer.offer.assignment_id]);
    const promo2 = await reserve(customer.contactId, 'follow-up-2', true, false);
    assert.ok(promo2);
    assert.notEqual(promo2.package_id, promo.package_id);
    assert.notEqual(promo2.package_id, customer.offer.package_id);
    await finish(promo2);
    await db.query(`UPDATE ${table('chatbot_pricing_deliveries')} SET sent_at=now()-interval '3 hours' WHERE assignment_id=$1 AND id<>$2`, [customer.offer.assignment_id, promo2.delivery_id]);
    assert.equal(await reserve(customer.contactId, 'no-repeat', true), null);
    await db.query(`UPDATE ${table('contacts')} SET pipeline_stage='converted' WHERE id=$1`, [customer.contactId]);
    await db.query(`SELECT ${table('capture_chatbot_pricing_outcome')}($1,'converted')`, [customer.contactId]);
    const metrics = await analytics();
    assert.equal(Number(metrics.find(row => row.package_id === customer.offer.package_id).converted), 1, 'Fair results stay attributed to the starting package');
    assert.equal(Number(metrics.find(row => row.package_id === promo2.package_id).last_touch_converted), 1, 'Last touch tracks the latest delivered offer');
    assert.equal(metrics.reduce((sum, row) => sum + Number(row.qualified), 0), 1, 'Conversion implies qualified once');
    assert.equal(await reserve(customer.contactId, 'converted-stop', true), null);

    // System tags work even when a person has not changed the pipeline.
    const tagged = cohorts[1];
    const tagId = randomUUID();
    await db.query(`INSERT INTO ${table('tags')}(id,name,owner_type,owner_id,page_id,system_key) VALUES($1,'Qualified','page',$2,$2,'qualified')`, [tagId, pageId]);
    await db.query(`INSERT INTO ${table('contact_tags')} VALUES($1,$2) ON CONFLICT DO NOTHING`, [tagged.contactId, tagId]);
    assert.equal((await analytics()).reduce((sum, row) => sum + Number(row.qualified), 0), 2);
    assert.equal(await reserve(tagged.contactId, 'qualified-tag-stop', true), null);

    const stopped = cohorts[2];
    await db.query(`UPDATE ${table('contacts')} SET last_inbound_at=now()-interval '25 hours' WHERE id=$1`, [stopped.contactId]);
    assert.equal(await reserve(stopped.contactId, 'outside-window', true), null);
    const manual = cohorts[3];
    await db.query(`UPDATE ${table('contacts')} SET pipeline_stage_source='manual' WHERE id=$1`, [manual.contactId]);
    assert.equal(await reserve(manual.contactId, 'staff-owned', true), null);

    const pausedContact = await newContact();
    const paused = await reserve(pausedContact, 'paused-delivery');
    await db.query(`UPDATE ${table('chatbot_pricing_experiments')} SET status='paused' WHERE id=$1`, [runId]);
    assert.equal((await db.query(`SELECT ${table('chatbot_pricing_offer_is_active')}($1) AS active`, [paused.delivery_id])).rows[0].active, false);
    assert.equal(await reserve(await newContact(), 'paused'), null);
    await release(paused);
    assert.equal((await db.query(`SELECT count(*)::int n FROM ${table('contact_tags')} WHERE contact_id=$1`, [pausedContact])).rows[0].n, 0, 'Unsent reservations do not add tags');
    const nextRun = await createRun({ mode: 'fair_test', duration_seconds: null });
    assert.notEqual(nextRun, runId);
    assert.equal((await db.query(`SELECT status FROM ${table('chatbot_pricing_experiments')} WHERE id=$1`, [runId])).rows[0].status, 'archived');
    assert.equal(await reserve(cohorts[4].contactId, 'existing-customer'), null, 'Earlier exposed customers cannot switch runs');
    assert.equal((await analytics()).reduce((sum, row) => sum + Number(row.exposed), 0), 30, 'New runs preserve old results');
    const fairContact = await newContact();
    const fair = await reserve(fairContact, 'fair-quote', false, true, null);
    await finish(fair);
    await db.query(`UPDATE ${table('chatbot_pricing_deliveries')} SET sent_at=now()-interval '3 hours' WHERE assignment_id=$1`, [fair.assignment_id]);
    assert.equal(await reserve(fairContact, 'fair-no-alternatives', true, false, null), null);
    assert.deepEqual(await analytics(otherPageId, nextRun), [], 'Analytics cannot cross Page boundaries');

    const seqRun = await createRun({ mode: 'sequence', duration_seconds: null }, otherPageId);
    const firstPackage = (await db.query(`SELECT id FROM ${table('chatbot_pricing_packages')} WHERE experiment_id=$1 ORDER BY position LIMIT 1`, [seqRun])).rows[0].id;
    for (let index = 0; index < 3; index++) {
        const sequenceOffer = await reserve(await newContact(otherPageId), 'sequence', false, true, null, otherPageId);
        assert.equal(sequenceOffer.package_id, firstPackage);
        await release(sequenceOffer);
    }

    // Catalogs are test arms; durations are eligibility strata inside each arm.
    const catalogPage = randomUUID();
    await db.query(`INSERT INTO ${table('pages')} VALUES($1)`, [catalogPage]);
    const catalogPackages = Array.from({ length: 4 }, (_, index) => ({
        name: index === 0 ? 'Existing catalog control' : 'Additional catalog ' + index,
        hook: index ? 'Approved hook ' + index : '', price: 600 + index * 100, message: '',
        options: [16, 24, 60].map(duration => ({ duration_seconds: duration, price: 600 + index * 100 + duration,
            addon_videos: index + 1, posters: 2, captions: 2, ...(duration === 60 && index === 1 ? { bonus_video_seconds: 16 } : {}) }))
    }));
    const catalogRun = await createRun({ duration_seconds: null, packages: catalogPackages }, catalogPage);
    const catalogMetrics = async duration => (await db.query(`SELECT ${table('get_chatbot_pricing_analytics')}($1,$2,$3) AS metrics`, [catalogPage, catalogRun, duration])).rows[0].metrics;
    const catalogReserve = (contact, key, duration, followUp = false) => reserve(contact, key, followUp, true, duration, catalogPage);
    const unknownDuration = await newContact(catalogPage);
    assert.equal(await catalogReserve(unknownDuration, 'unknown-duration', null), null, 'Never pick a catalog before duration is known');
    assert.equal(await catalogReserve(unknownDuration, 'unsupported-duration', 32), null);
    let catalogCustomer;
    for (const duration of [16, 24]) {
        for (let index = 0; index < 4; index++) {
            const contactId = await newContact(catalogPage);
            const offer = await catalogReserve(contactId, 'catalog-quote', duration);
            assert.equal(offer.duration_seconds, duration);
            assert.equal(offer.option.duration_seconds, duration);
            assert.equal(offer.price, catalogPackages.find(pkg => pkg.name === offer.package_name).options.find(option => option.duration_seconds === duration).price);
            await finish(offer);
            catalogCustomer ||= { contactId, offer };
        }
        assert.deepEqual((await catalogMetrics(duration)).map(row => Number(row.assigned)), [1,1,1,1], 'Each duration is balanced independently');
    }
    const changedLength = await catalogReserve(catalogCustomer.contactId, 'changed-to-60s', 60);
    assert.equal(changedLength.package_id, catalogCustomer.offer.package_id, 'Changing video length preserves assigned catalog');
    assert.equal(changedLength.duration_seconds, 60);
    const retryChangedLength = await catalogReserve(catalogCustomer.contactId, 'changed-to-60s', 24);
    assert.equal(retryChangedLength.duration_seconds, 60, 'A reserved source keeps its exact quote snapshot');
    assert.equal(retryChangedLength.price, changedLength.price);
    await finish(changedLength);
    await db.query(`UPDATE ${table('chatbot_pricing_deliveries')} SET sent_at=now()-interval '3 hours' WHERE assignment_id=$1`, [changedLength.assignment_id]);
    const catalogPromo = await catalogReserve(catalogCustomer.contactId, 'next-catalog', 60, true);
    assert.notEqual(catalogPromo.package_id, changedLength.package_id);
    assert.equal(catalogPromo.duration_seconds, 60, 'Alternative catalog quotes the same currently selected main duration');
    await finish(catalogPromo);
    const currentContactCatalog = (await db.query(`SELECT ${table('get_chatbot_pricing_contact_catalog')}($1,$2) AS catalog`, [catalogPage,catalogCustomer.contactId])).rows[0].catalog;
    assert.equal(currentContactCatalog.name, catalogPromo.package_name, 'Conversation answers use the latest delivered catalog');
    const customerQuestion = await catalogReserve(catalogCustomer.contactId, 'question-after-promo', 24);
    assert.equal(customerQuestion.package_id, catalogPromo.package_id, 'A reply after a promotion keeps that catalog');
    assert.equal(customerQuestion.duration_seconds, 24);
    await release(customerQuestion);
    await db.query(`UPDATE ${table('contacts')} SET pipeline_stage='converted' WHERE id=$1`, [catalogCustomer.contactId]);
    assert.equal((await catalogMetrics(16)).reduce((sum,row) => sum + Number(row.converted), 0), 1, 'Outcome remains in starting-duration cohort');
    assert.equal((await catalogMetrics(24)).reduce((sum,row) => sum + Number(row.converted), 0), 0);
    assert.equal((await catalogMetrics(60)).reduce((sum,row) => sum + Number(row.assigned), 0), 0, 'A changed length does not re-enroll a customer');
    await db.query('ROLLBACK');
    console.log(JSON.stringify({ passed: true, migrationIdempotent: true, balancedCustomers: 30,
        stickyAssignment: true, progressiveOffers: true, observedOutcomes: true, pauseAndWindowStops: true,
        pageIsolation: true, previousRunsPreserved: true, catalogArms: 4, durationBalance: true,
        stickyCatalogOnDurationChange: true, snapshotRetry: true, scratchSchemaRolledBack: true, customerMessagesSent: 0 }));
} finally { await db.query('ROLLBACK').catch(() => {}); await db.end(); }
