import fs from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';

const mode = process.argv.find(v => ['--inspect', '--preflight', '--apply', '--launch'].includes(v));
if (!mode) throw new Error('Choose --inspect, --preflight, --apply or --launch');
if (new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname !== 'vhtbmdizugnxkgocmruq.supabase.co') throw new Error('Expected the maintained VEO database');
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 180000 });
try {
    await db.connect();
    if (mode === '--inspect') {
        const users = await db.query(`SELECT u.id,u.name,u.email,(u.facebook_id IS NOT NULL) AS facebook_bound,count(up.page_id)::int AS pages FROM users u LEFT JOIN user_pages up ON up.user_id=u.id GROUP BY u.id ORDER BY pages DESC LIMIT 10`);
        const pages = await db.query('SELECT id,name,fb_page_id FROM pages ORDER BY name');
        const state = await db.query("SELECT to_regclass('public.veo_tenants') IS NOT NULL AS prepared");
        console.log(JSON.stringify({ users: users.rows, pages: pages.rows, ...state.rows[0] }, null, 2));
    } else {
        await db.query('BEGIN');
        if (mode === '--launch') {
            const owner = process.env.VEO_OWNER_USER_ID;
            assert(owner, 'VEO_OWNER_USER_ID must identify the retained CJ Lara account');
            const who = (await db.query('SELECT id,name FROM users WHERE id=$1', [owner])).rows[0];
            assert(who && /cj|lara/i.test(who.name), 'Launch must retain the identified CJ Lara identity');
            const already = (await db.query('SELECT launch_at FROM veo_tenants WHERE owner_id=$1', [owner])).rows[0];
            assert(!already?.launch_at, 'Workspace is already launched; retain its existing cutoff and receipt');
            const approved = JSON.parse(fs.readFileSync('src/config/veo-pages.json', 'utf8'));
            const pages = (await db.query('SELECT id,name,fb_page_id FROM pages WHERE id IN(SELECT page_id FROM user_pages WHERE user_id=$1)', [owner])).rows
                .filter(p => approved.some(a => a.facebook_page_id ? a.facebook_page_id === p.fb_page_id : a.name.toLowerCase() === p.name.toLowerCase()));
            assert(pages.length, 'No retained VEO page connections found');
            const tenant = (await db.query('SELECT veo_launch($1,$2) AS id', [owner, pages.map(p => p.id)])).rows[0].id;
            // Quarantine every legacy scheduled job without deleting its audit history.
            await db.query("UPDATE campaigns SET status='cancelled',loop_status='stopped',is_loop=false,recurrence='none',background_delivery_enabled=false WHERE created_at<(SELECT launch_at FROM veo_tenants WHERE id=$1)", [tenant]);
            await db.query("UPDATE workflow_automations SET enabled=false WHERE created_at<(SELECT launch_at FROM veo_tenants WHERE id=$1)", [tenant]);
            await db.query("UPDATE workflow_automation_states SET status='stopped' WHERE status='active'");
            await db.query("UPDATE conversation_export_jobs SET status='failed',error_message='Archived at VEO workspace launch' WHERE created_at<(SELECT launch_at FROM veo_tenants WHERE id=$1) AND status IN('queued','running')", [tenant]);
            // Establish the cutoff after archiving, immediately before commit. The compatible
            // webhook already journals events against this database-controlled timestamp.
            await db.query('UPDATE veo_tenants SET launch_at=clock_timestamp() WHERE id=$1', [tenant]);
            const launch = (await db.query('SELECT id,launch_at FROM veo_tenants WHERE id=$1', [tenant])).rows[0];
            await db.query('COMMIT');
            const receipt = { launched: true, ...launch, owner: who.id, pages: pages.map(p => ({ id: p.id, name: p.name })) };
            fs.writeFileSync('.vercel/workspace-launch-receipt.json', JSON.stringify(receipt, null, 2));
            console.log(JSON.stringify(receipt, null, 2));
        } else {
            const before = (await db.query('SELECT count(*)::int AS users,(SELECT count(*)::int FROM user_pages) AS connections,(SELECT count(*)::int FROM contact_verified_payments) AS payments FROM users')).rows[0];
            for (const file of ['202611050010_veo_workspace.sql', '202611050011_veo_workspace_workers.sql', '202611050012_veo_workspace_hardening.sql', '202611050013_veo_refund_and_submission_recovery.sql', '202611050014_veo_salary_reconciliation_queue.sql', '202611050015_veo_review_corrections.sql', '202611050016_veo_contacts_and_telegram_profile.sql', '202611050017_veo_team_capacity.sql', '202611050018_veo_current_team_planning.sql', '202611050019_veo_conversation_event_leases.sql', '202611050020_veo_staff_and_delivery.sql', '202611050021_veo_performance_finance.sql', '202611050022_veo_page_capacity_budget.sql', '202611050023_veo_telegram_workforce.sql', '202611050024_veo_shift_reports.sql', '202611050025_veo_current_telegram_group.sql', '202611050026_veo_calendar_message_metadata.sql', '202611050027_veo_calendar_analytics.sql', '202611050028_veo_distinct_client_release.sql', '202611070001_veo_ad_spend_coverage.sql']) {
                const version = file.split('_')[0];
                const installed = await db.query('SELECT EXISTS(SELECT 1 FROM app_private.schema_migrations WHERE version=$1) AS done', [version]);
                if (installed.rows[0].done) continue;
                const sql = fs.readFileSync('supabase/migrations/' + file, 'utf8').replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
                await db.query(sql);
                await db.query('INSERT INTO app_private.schema_migrations(version,description) VALUES($1,$2)', [version, file]);
                if ((await db.query("SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS present")).rows[0].present)
                    await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3::text[]) ON CONFLICT(version) DO NOTHING', [version, file.replace('.sql', ''), [sql]]);
            }
            const after = (await db.query('SELECT count(*)::int AS users,(SELECT count(*)::int FROM user_pages) AS connections,(SELECT count(*)::int FROM contact_verified_payments) AS payments FROM users')).rows[0];
            assert.deepEqual(after, before);
            assert.equal((await db.query("SELECT has_function_privilege('anon','veo_action(uuid,text,jsonb)','EXECUTE') AS allowed")).rows[0].allowed, false);
            await db.query(mode === '--apply' ? 'COMMIT' : 'ROLLBACK');
            console.log(JSON.stringify({ passed: true, applied: mode === '--apply', retained: before, launch_changed: false }));
        }
    }
} catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error(JSON.stringify({ passed: false, error: e.message }));
    process.exitCode = 1;
} finally { await db.end(); }
