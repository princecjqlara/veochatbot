// Preview by default. --apply-schema installs only additive objects. --activate
// installs the approved catalogs on existing commercial Pages after deployment.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
const module = await import('../src/lib/chatbot-pricing-catalogs.ts');
const { currentPricingCatalog, OWNER_PRICING_CATALOGS } = module.currentPricingCatalog ? module : module.default;
const pricingModule = await import('../src/lib/chatbot-pricing.ts');
const { validatePricingExperiment } = pricingModule.validatePricingExperiment ? pricingModule : pricingModule.default;
const applySchema = process.argv.includes('--apply-schema');
const activate = process.argv.includes('--activate');
assert.ok(!(applySchema && activate), 'Schema and activation are separate steps');
const out = new URL('../../data/', import.meta.url);
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_6543 || process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 45000 });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
await db.connect();
try {
    await db.query("SET lock_timeout='5s'; SET statement_timeout='45s'");
    const configs = (await db.query('SELECT c.*,p.name FROM public.chatbot_configs c JOIN public.pages p ON p.id=c.page_id ORDER BY c.page_id')).rows;
    const selected = configs.filter(row => row.commercial_video_intake_enabled);
    assert.ok(selected.length, 'No configured commercial video Pages');
    const snapshot = await readFile(new URL('../supabase/migrations/202610220002_chatbot_pricing_experiments.sql', import.meta.url), 'utf8');
    if (applySchema) {
        await writeFile(new URL('pricing-schema-before-' + Date.now() + '.json', out), JSON.stringify({ at: new Date().toISOString(), configs,
            migrationSha256: digest(snapshot) }, null, 2), { flag: 'wx' });
        await db.query(snapshot);
        assert.equal((await db.query("SELECT count(*)::int AS n FROM app_private.schema_migrations WHERE version='20261022_002'")).rows[0].n, 1);
        assert.equal(digest((await db.query('SELECT c.*,p.name FROM public.chatbot_configs c JOIN public.pages p ON p.id=c.page_id ORDER BY c.page_id')).rows), digest(configs));
        console.log(JSON.stringify({ schemaApplied: true, botSettingsChanged: 0, runsCreated: 0, messagesSent: 0 }));
        process.exitCode = 0;
    } else {
        const planned = [];
        const sources = new Map();
        for (const config of selected) {
            const sourceId = config.knowledge_source_page_id || config.page_id;
            if (!sources.has(sourceId)) {
                const documents = (await db.query("SELECT id,title,content,updated_at FROM public.chatbot_knowledge_documents WHERE page_id=$1 AND status='ready' AND (content ILIKE '%current owner-approved promo catalog%' OR content ILIKE '%owner-approved promo price list%') ORDER BY updated_at DESC LIMIT 50", [sourceId])).rows;
                const control = currentPricingCatalog(documents.map(document => ({ ...document, chunk_id: document.id, document_id: document.id, similarity: 1 })));
                sources.set(sourceId, { control, knowledgeDigest: digest(documents) });
            }
            const source = sources.get(sourceId);
            const configDraft = validatePricingExperiment({ name: 'Current + 3 approved catalogs', mode: 'fair_test_sequence',
                duration_seconds: null, follow_up_gap_minutes: 120, attribution_days: 7, minimum_sample: 100,
                packages: [source.control, ...OWNER_PRICING_CATALOGS] });
            planned.push({ pageId: config.page_id, page: config.name.trim(), enabled: config.enabled, followUpEnabled: config.follow_up_enabled,
                sourcePageId: sourceId, knowledgeDigest: source.knowledgeDigest, config: configDraft });
        }
        const plan = { at: new Date().toISOString(), mode: activate ? 'activate' : 'preview',
            pages: planned.map(row => ({ pageId: row.pageId, page: row.page, enabled: row.enabled, followUpEnabled: row.followUpEnabled,
                catalogs: row.config.packages.map(pkg => ({ name: pkg.name, hook: pkg.hook || '', options: pkg.options })) })),
            firstInquiriesAfterActivationOnly: true, minimumGapMinutes: 120, attributionDays: 7, messagesSent: 0 };
        await writeFile(new URL('pricing-rollout-plan-2026-10-22.json', out), JSON.stringify(plan, null, 2));
        if (!activate) {
            console.log(JSON.stringify({ preview: true, pages: plan.pages.map(page => ({ page: page.page, enabled: page.enabled,
                followUpEnabled: page.followUpEnabled, catalogs: page.catalogs.length })), minimumGapMinutes: 120,
                firstInquiriesAfterActivationOnly: true, writes: 0, messagesSent: 0 }));
        } else {
            // Ensure the deployed app recognizes the catalog format before a live run exists.
            const { encode } = await import('next-auth/jwt');
            const first = planned[0];
            const user = (await db.query('SELECT user_id FROM public.user_pages WHERE page_id=$1 LIMIT 1', [first.pageId])).rows[0];
            assert.ok(user, 'A Page member is required for deployed API verification');
            const token = await encode({ secret: process.env.NEXTAUTH_SECRET, token: { id: user.user_id, name: 'Pricing rollout verification' }, maxAge: 600 });
            const response = await fetch('https://veochatbot.vercel.app/api/pages/' + first.pageId + '/chatbot/pricing?presets=owner', {
                headers: { Cookie: '__Secure-next-auth.session-token=' + token }, signal: AbortSignal.timeout(30000) });
            assert.equal(response.status, 200, 'Deploy the pricing application before activation');
            const preview = await response.json();
            assert.equal(preview.packages.length, 4);
            assert.deepEqual(validatePricingExperiment({ ...first.config, packages: preview.packages }).packages, first.config.packages);

            await db.query('BEGIN');
            try {
                // Lock settings while checking that the scoped rollout changes none of them.
                const before = (await db.query('SELECT * FROM public.chatbot_configs ORDER BY page_id FOR UPDATE')).rows;
                const existing = (await db.query("SELECT * FROM public.chatbot_pricing_experiments WHERE status<>'archived' ORDER BY page_id FOR UPDATE")).rows;
                const backup = 'pricing-activation-before-' + Date.now() + '.json';
                await writeFile(new URL(backup, out), JSON.stringify({ at: new Date().toISOString(), configs: before, runs: existing, planned }, null, 2), { flag: 'wx' });
                const activated = [];
                for (const row of planned) {
                    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['chatbot_pricing:' + row.pageId]);
                    const current = existing.find(run => run.page_id === row.pageId);
                    if (current) {
                        const packages = (await db.query('SELECT name,price,message,hook,options FROM public.chatbot_pricing_packages WHERE experiment_id=$1 ORDER BY position', [current.id])).rows;
                        const comparable = validatePricingExperiment({ ...current, packages: packages.map(pkg => ({ ...pkg, price: Number(pkg.price) })) });
                        assert.deepEqual(comparable, row.config, 'An existing run differs; do not replace an owner-edited experiment');
                        activated.push({ pageId: row.pageId, page: row.page, experimentId: current.id, status: current.status, reused: true });
                        continue;
                    }
                    const experimentId = (await db.query('SELECT public.create_chatbot_pricing_experiment($1,$2) AS id', [row.pageId, row.config])).rows[0].id;
                    activated.push({ pageId: row.pageId, page: row.page, experimentId, status: 'active', enabled: row.enabled, followUpEnabled: row.followUpEnabled });
                }
                assert.deepEqual((await db.query('SELECT * FROM public.chatbot_configs ORDER BY page_id')).rows, before);
                for (const [sourceId, source] of sources) {
                    const documents = (await db.query("SELECT id,title,content,updated_at FROM public.chatbot_knowledge_documents WHERE page_id=$1 AND status='ready' AND (content ILIKE '%current owner-approved promo catalog%' OR content ILIKE '%owner-approved promo price list%') ORDER BY updated_at DESC LIMIT 50", [sourceId])).rows;
                    assert.equal(digest(documents), source.knowledgeDigest, 'Original knowledge must remain unchanged');
                }
                await db.query('COMMIT');
                const receipt = { at: new Date().toISOString(), activated, mode: 'fair_test_sequence', gapMinutes: 120,
                    botSettingsChanged: 0, originalKnowledgeChanged: 0, workersInvoked: 0, testMessagesSent: 0, backup };
                await writeFile(new URL('pricing-activation-2026-10-22.json', out), JSON.stringify(receipt, null, 2));
                console.log(JSON.stringify(receipt));
            } catch (error) { await db.query('ROLLBACK'); throw error; }
        }
    }
} finally { await db.query('ROLLBACK').catch(() => {}); await db.end(); }
