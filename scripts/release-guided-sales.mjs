// Read-only inspection by default; --apply adds settings without touching handoff/state/jobs.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import pg from 'pg';
const require = createRequire(import.meta.url);
const { parse } = require('../../node_modules/dotenv');
const env = parse(fs.readFileSync(new URL('../.env.local', import.meta.url)));
const db = new pg.Client({ connectionString: env.DATABASE_POOLER_URL_5432 || env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 30000 });
const out = path.resolve(import.meta.dirname, '../../data/guided-sales-2026-10-30');
fs.mkdirSync(out, { recursive: true });
const receipt = { at: new Date().toISOString(), applied: false, customerMessagesSent: 0, contactWrites: 0 };
try {
    await db.connect();
    const configs = (await db.query(`SELECT c.*, p.name, p.fb_page_id FROM chatbot_configs c JOIN pages p ON p.id=c.page_id ORDER BY p.name`)).rows;
    const tables = (await db.query(`SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public'
        AND table_name IN ('chatbot_configs','chatbot_contact_states','chatbot_follow_up_jobs') ORDER BY table_name,ordinal_position`)).rows;
    receipt.pages = configs.map(c => ({ page: c.name, enabled: c.enabled, commercialIntake: c.commercial_video_intake_enabled,
        guidedSales: c.guided_sales_enabled || false, fields: c.sales_form_fields || null, model: c.model,
        requiredDetails: c.details_to_collect, followUps: c.follow_up_enabled, policyRevision: c.policy_revision }));
    receipt.schemaColumns = tables.length;
    if (process.argv.includes('--apply')) {
        fs.writeFileSync(path.join(out, `settings-backup-${Date.now()}.json`), JSON.stringify(configs, null, 2));
        const targetIds = configs.filter(c => c.commercial_video_intake_enabled).map(c => c.page_id);
        assert.ok(targetIds.length > 0, 'Existing commercial intake Pages required');
        await db.query('BEGIN');
        try {
            await db.query(fs.readFileSync(new URL('../supabase/migrations/202610300001_guided_sales_intake.sql', import.meta.url), 'utf8'));
            await db.query('UPDATE chatbot_configs SET guided_sales_enabled=true WHERE page_id=ANY($1::uuid[])', [targetIds]);
            const after = (await db.query('SELECT * FROM chatbot_configs')).rows;
            for (const old of configs) {
                const current = after.find(c => c.page_id === old.page_id);
                for (const field of Object.keys(old).filter(key => !['name','fb_page_id','guided_sales_enabled','sales_form_fields','updated_at'].includes(key))) {
                    assert.deepEqual(current[field], old[field], `${old.name}: preserve ${field}`);
                }
                assert.equal(current.guided_sales_enabled, old.commercial_video_intake_enabled || old.guided_sales_enabled || false);
            }
            await db.query('COMMIT');
            receipt.applied = true;
            receipt.updatedPages = targetIds.length;
            receipt.existingSettingsPreserved = true;
        } catch (e) { await db.query('ROLLBACK'); throw e; }
    }
} catch (e) { receipt.error = String(e.message).slice(0, 500); process.exitCode = 1; }
finally {
    await db.end();
    fs.writeFileSync(path.join(out, receipt.applied ? 'release.json' : 'inspection.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt, null, 2));
}
