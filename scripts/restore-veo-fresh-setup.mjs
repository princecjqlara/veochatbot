// Destination-only restore of verified setup and workforce, with no customer history.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { assertProjectCredentials, VEO_RECOVERY_PROJECT, sqlIdentifier as ident, digest } from './lib/database-migration-safety.mjs';
import { migrationMetadataSql, migrationForeignKeysSql } from './lib/migration-data.mjs';
import { importDependencyOrder } from './lib/migration-import.mjs';
import { readVerifiedSetup, validateRecoveryRoster, freshSetupTables, canonicalValue } from './lib/veo-fresh-setup.mjs';

const owner = 'be58bd9f-059d-4368-8733-99eb8b18a371';
async function main() {
    const modes = ['--preflight','--apply'].filter(a => process.argv.includes(a));
    if (modes.length !== 1) throw Error('Choose --preflight or --apply');
    const apply = modes[0] === '--apply', { connectionString } = assertProjectCredentials(process.env, VEO_RECOVERY_PROJECT);
    const source = readVerifiedSetup('.vercel/veo-reset');
    const workspace = JSON.parse(fs.readFileSync('.vercel/telegram-multi-mapping-before.json', 'utf8')).workspace;
    const roster = validateRecoveryRoster(workspace, owner);
    const approved = JSON.parse(fs.readFileSync('src/config/veo-pages.json', 'utf8'));
    const approvedFb = new Set(approved.map(p => p.facebook_page_id).filter(Boolean));
    const savedPageIds = new Set(workspace.pages.map(p => p.id));
    const pages = source.rows.pages.filter(p => savedPageIds.has(p.id) && approvedFb.has(p.fb_page_id));
    if (pages.length !== approvedFb.size) throw Error('A verified connected Page is missing from setup backup');
    const ids = new Set(pages.map(p => p.id));
    const report = { target: VEO_RECOVERY_PROJECT, startedAt: new Date().toISOString(), applied: false,
        sourceSetupAt: source.manifest.started_at, sourceRosterAt: workspace.checked_at, restored: [],
        pendingPageConnections: workspace.pages.filter(p => !ids.has(p.id)).map(p => ({ id:p.id,name:p.name })),
        accountsNeedingCredentials: roster.map(a => ({ id:a.user_id,name:a.name,role:a.role })),
        customerHistoryImported: false, productionSwitched: false, sourceDatabaseConnections: 0 };
    const dir = '.vercel/veo-fresh-start'; fs.mkdirSync(dir,{recursive:true});
    const db = new pg.Client({ connectionString, ssl:{rejectUnauthorized:false}, connectionTimeoutMillis:8000, query_timeout:20000, statement_timeout:15000 });
    db.on('error',()=>{});
    try {
        await db.connect(); await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await db.query("SET LOCAL lock_timeout='3s'; SET LOCAL timezone='UTC'; SET LOCAL extra_float_digits=3");
        if (!(await db.query('SELECT pg_try_advisory_xact_lock(76110910) AS locked')).rows[0].locked) throw Error('Another fresh setup restore is active');
        const appTables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
        for (const t of appTables) {
            if(t.tablename==='ad_tracking_settings')continue; // One known migration-seeded singleton, replaced below.
            const found = await db.query('SELECT 1 FROM public.'+ident(t.tablename)+' LIMIT 1');
            if (found.rows.length) throw Error('Destination is no longer empty: '+t.tablename);
        }
        const metadata = (await db.query(migrationMetadataSql)).rows, foreignKeys = (await db.query(migrationForeignKeysSql)).rows;
        const data = Object.fromEntries(freshSetupTables.map(name=>[name,source.rows[name]]));
        const seed=(await db.query('SELECT singleton FROM ad_tracking_settings')).rows;
        if(seed.length>1||seed.some(r=>r.singleton!==true))throw Error('Unexpected destination settings seed');
        await db.query('DELETE FROM ad_tracking_settings WHERE singleton=true');
        data.ad_tracking_settings=[{singleton:true,started_at:new Date().toISOString()}];
        data.pages = pages.map(p=>({...p,last_synced_at:null,automation_app_id:null,messaging_auto_tag_cursor:null,messaging_auto_tag_owner:null,
            messaging_auto_tag_lease_until:null,messaging_auto_tag_scan_started_at:null,messaging_auto_tag_last_error:null,
            campaign_delivery_owner:null,campaign_delivery_lease_until:null,campaign_delivery_cooldown_until:null,
            campaign_delivery_rate_strikes:0,campaign_delivery_last_rate_limit_at:null}));
        // Old deployment lease fields are not chatbot settings and have no
        // meaning in the empty replacement. Omit only these explicit columns.
        const obsoleteLeaseFields=['campaign_delivery_owner','messaging_auto_tag_owner','campaign_delivery_lease_until',
            'campaign_delivery_rate_strikes','campaign_delivery_cooldown_until','campaign_delivery_last_rate_limit_at'];
        for(const page of data.pages)for(const field of obsoleteLeaseFields)if(!metadata.some(m=>m.table_name==='pages'&&m.column_name===field))delete page[field];
        for (const [name,rows] of Object.entries(data)) if (name!=='pages') {
            data[name] = rows.filter(r=>!r.page_id || ids.has(r.page_id));
        }
        // Keep only account identities required by the verified roster or setup FKs.
        const requiredUsers = new Set(roster.map(a=>a.user_id));
        for (const fk of foreignKeys.filter(f=>f.parent==='users' && data[f.child])) for (const row of data[fk.child]) for (const column of fk.child_columns) if(row[column])requiredUsers.add(row[column]);
        const oldUsers = new Map(source.rows.users.map(u=>[u.id,u]));
        data.users = [...requiredUsers].map(id=>{
            const saved = oldUsers.get(id), account = roster.find(a=>a.user_id===id);
            if(!saved&&!account)throw Error('Missing referenced setup identity');
            return { id,name:account?.name||saved.name,email:null,password_hash:null,role:account?.role||'user',is_active:false,
                image:saved?.image||null,facebook_id:saved?.facebook_id||null };
        });
        const triggers=(await db.query("SELECT c.relname AS table_name,t.tgname,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p') AND NOT t.tgisinternal")).rows;
        for (const table of Object.keys(data)) await db.query('ALTER TABLE public.'+ident(table)+' DISABLE TRIGGER USER');
        const tableSpecs = Object.entries(data).map(([name,rows])=>({name,rows,columns:[...new Set(rows.flatMap(Object.keys))]}));
        for (const table of importDependencyOrder(tableSpecs,foreignKeys)) {
            if(!table.rows.length)continue;
            const columns=table.columns.filter(c=>metadata.some(m=>m.table_name===table.name&&m.column_name===c&&!m.generated));
            if(columns.length!==table.columns.length)throw Error('Setup column is absent: '+table.name);
            const fields=columns.map(ident).join(',');
            for(let offset=0;offset<table.rows.length;offset+=50) {
                await db.query(`INSERT INTO public.${ident(table.name)}(${fields}) OVERRIDING SYSTEM VALUE SELECT ${fields} FROM jsonb_populate_recordset(NULL::public.${ident(table.name)},$1::jsonb)`,[JSON.stringify(table.rows.slice(offset,offset+50))]);
            }
            const actual=(await db.query(`SELECT to_jsonb(r)::text AS raw FROM (SELECT ${fields} FROM public.${ident(table.name)}) r ORDER BY to_jsonb(r)::text`)).rows.map(r=>JSON.stringify(canonicalValue(JSON.parse(r.raw))));
            const expected=(await db.query(`SELECT to_jsonb(r)::text AS raw FROM (SELECT ${fields} FROM jsonb_populate_recordset(NULL::public.${ident(table.name)},$1::jsonb)) r`,[JSON.stringify(table.rows)])).rows.map(r=>JSON.stringify(canonicalValue(JSON.parse(r.raw))));
            if(digest(actual.sort().join('\n'))!==digest(expected.sort().join('\n')))throw Error('Restored setup differs: '+table.name);
            report.restored.push({table:table.name,rows:table.rows.length,verified:true});
        }
        for(const t of triggers)if(data[t.table_name])await db.query('ALTER TABLE public.'+ident(t.table_name)+' '+({O:'ENABLE',D:'DISABLE',R:'ENABLE REPLICA',A:'ENABLE ALWAYS'}[t.tgenabled])+' TRIGGER '+ident(t.tgname));
        await db.query('INSERT INTO veo_tenants(id,owner_id,name,launch_at) VALUES($1,$2,$3,clock_timestamp())',[workspace.tenant_id,owner,workspace.name||'VEO']);
        for(const a of roster)await db.query('INSERT INTO veo_accounts(user_id,tenant_id,role,parent_id,active,telegram_username) VALUES($1,$2,$3,$4,true,$5)',[a.user_id,workspace.tenant_id,a.role,a.parent_id,a.telegram_username||null]);
        await db.query('UPDATE pages SET veo_tenant_id=$1,veo_enabled=true,automation_app_id=$2 WHERE id=ANY($3::uuid[])',[workspace.tenant_id,process.env.FACEBOOK_CLIENT_ID,[...ids]]);
        for(const a of roster) for(const page of a.page_ids.filter(p=>ids.has(p)))await db.query('INSERT INTO user_pages(user_id,page_id) VALUES($1,$2) ON CONFLICT(user_id,page_id) DO NOTHING',[a.user_id,page]);
        for(const team of workspace.teams||[])await db.query('INSERT INTO veo_teams(id,tenant_id,manager_id,name,telegram_chat_id,telegram_thread_id) VALUES($1,$2,$3,$4,NULL,NULL)',[team.id,workspace.tenant_id,team.manager_id,team.name]);
        if(!/^\d+$/.test(process.env.FACEBOOK_CLIENT_ID||''))throw Error('Current Facebook app configuration required');
        await db.query('INSERT INTO app_private.veobot_runtime_policy(singleton,app_id,enforced) VALUES(true,$1,true) ON CONFLICT(singleton) DO UPDATE SET app_id=EXCLUDED.app_id,enforced=true',[process.env.FACEBOOK_CLIENT_ID]);
        const counts = (await db.query(`SELECT (SELECT count(*)::int FROM contacts) AS contacts,(SELECT count(*)::int FROM veo_orders) AS orders,
            (SELECT count(*)::int FROM veo_payments) AS payments,(SELECT count(*)::int FROM veo_archive_records) AS archives,
            (SELECT count(*)::int FROM contact_profile_messages) AS raw_messages,(SELECT count(*)::int FROM veo_event_inbox) AS events`)).rows[0];
        if(Object.values(counts).some(n=>n!==0))throw Error('Fresh database unexpectedly contains customer history');
        report.freshCounts=counts;report.accounts=roster.length;report.teams=(workspace.teams||[]).length;report.pages=pages.length;
        report.sourceFingerprint=digest(JSON.stringify(source.manifest.retained));
        await db.query("INSERT INTO veo_audit(tenant_id,actor_id,action,after_value,reason) VALUES($1,$2,'fresh_setup_recovery',$3::jsonb,'Owner requested setup and workforce recovery with no customer history')",[workspace.tenant_id,owner,JSON.stringify({source_setup_at:report.sourceSetupAt,source_roster_at:report.sourceRosterAt,accounts:report.accounts,pages:report.pages,credentials_pending:true})]);
        await db.query(apply?'COMMIT':'ROLLBACK');report.applied=apply;report.passed=true;
    } catch(error) {
        await db.query('ROLLBACK').catch(()=>{});report.passed=false;report.code=error.code||'RESTORE_FAILED';
        report.error=String(error.message).replace(/postgres(?:ql)?:\/\/\S+|EA[A-Za-z0-9_-]{25,}/g,'[redacted]');process.exitCode=1;
    } finally {
        await db.end().catch(()=>{});report.completedAt=new Date().toISOString();
        fs.writeFileSync(path.join(dir,apply?'setup-apply.json':'setup-preflight.json'),JSON.stringify(report,null,2));
        console.log(JSON.stringify(report,null,2));
    }
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)await main();
