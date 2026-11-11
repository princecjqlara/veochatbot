import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {sqlIdentifier as ident} from './database-migration-safety.mjs';
const rootTables=['users','veo_accounts','veo_teams'];
const guarded={veo_audit:'veo_audit_readonly',veo_operating_quotas:'veo_operating_quota_readonly',veo_page_daily_capacity:'veo_page_capacity_readonly',veo_team_daily_capacity:'veo_team_capacity_readonly',veo_salary_days:'veo_salary_readonly',veo_salary_adjustments:'veo_adjustment_readonly',veo_archive_records:'veo_archive_readonly'};
const userColumns={
 users:['id'],veo_accounts:['user_id'],user_pages:['user_id'],business_users:['user_id'],tag_shares:['shared_with_user_id'],
 meta_ads_credentials:['user_id'],meta_ads_sync_state:['user_id'],veo_worker_mappings:['user_id'],
 veo_daily_targets:['user_id'],veo_operating_quotas:['user_id'],veo_attendance:['user_id'],
 veo_salary_days:['user_id'],veo_salary_adjustments:['user_id'],veo_salary_reconciliation:['user_id'],
 veo_page_capacity_weights:['user_id'],veo_staff_telegram_groups:['user_id'],veo_telegram_staff_state:['user_id'],
 veo_telegram_auto_grants:['user_id'],veo_telegram_auto_states:['user_id'],veo_telegram_link_codes:['user_id'],
 veo_telegram_memberships:['user_id'],veo_telegram_group_states:['user_id'],veo_telegram_pairing_codes:['consumed_by'],
 veo_telegram_intake_requests:['actor_id'],veo_intake_readiness:['user_id'],veo_page_authorizations:['actor_id'],
 veo_client_claims:['user_id','previous_user_id'],veo_client_offers:['offered_to','offered_by','previous_owner'],veo_intake_dispatch_attempts:['user_id']
};
const teamColumns={veo_teams:['id'],veo_team_telegram_groups:['team_id'],veo_team_telegram_pages:['team_id'],veo_team_daily_capacity:['team_id'],veo_page_daily_capacity:['team_id'],veo_ad_budget_plans:['team_id'],veo_intake_dispatch:['team_id']};
const args='WITH reset_args AS(SELECT $1::uuid[] ids,$2::uuid[] teams,$3::uuid tenant,$4::text[] login_keys) ';
const query=(db,sql,p)=>db.query(args+sql,p);
export async function inspectWorkforceReset(db,{owner,tenant}){
 const actor=(await db.query('SELECT a.role,a.active,u.is_active,t.owner_id FROM public.veo_accounts a JOIN public.users u ON u.id=a.user_id JOIN public.veo_tenants t ON t.id=a.tenant_id WHERE a.user_id=$1 AND a.tenant_id=$2',[owner,tenant])).rows[0];
 assert(actor?.role==='owner'&&actor.active&&actor.is_active&&actor.owner_id===owner,'Expected the active workspace Owner');
 const staff=(await db.query("SELECT a.user_id,a.role,a.parent_id,a.active,u.email FROM public.veo_accounts a JOIN public.users u ON u.id=a.user_id WHERE a.tenant_id=$1 AND a.user_id<>$2 ORDER BY a.user_id",[tenant,owner])).rows;
 assert(staff.every(a=>['team_leader','manager','member'].includes(a.role)),'Unexpected non-Owner role');
 const ids=staff.map(a=>a.user_id);assert(!ids.includes(owner),'Owner must never be reset');
 const teams=(await db.query('SELECT id FROM public.veo_teams WHERE tenant_id=$1 AND manager_id=ANY($2::uuid[]) ORDER BY id',[tenant,ids])).rows.map(t=>t.id);
 const p=[ids,teams,tenant,staff.filter(a=>a.email).map(a=>createHash('sha256').update(a.email.trim().toLowerCase()).digest('hex'))];
 const tables=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(t=>t.tablename),rules=new Map();
 for(const table of tables){const conditions=[...(userColumns[table]||[]).map(c=>`t.${ident(c)}=ANY($1::uuid[])`),...(teamColumns[table]||[]).map(c=>`t.${ident(c)}=ANY($2::uuid[])`)];if(conditions.length)rules.set(table,'('+conditions.join(' OR ')+')');}
 if(tables.includes('veo_login_limits'))rules.set('veo_login_limits','t.key=ANY($4::text[])');
 if(tables.includes('veo_audit'))rules.set('veo_audit',"t.tenant_id=$3 AND cardinality($1::uuid[])>0 AND to_jsonb(t)::text ~ array_to_string($1::uuid[]||$2::uuid[],'|')");
 if(tables.includes('veo_telegram_intake_tokens'))rules.set('veo_telegram_intake_tokens',"t.target_id=ANY($1::uuid[]) OR t.request_id IN(SELECT id FROM public.veo_telegram_intake_requests WHERE actor_id=ANY($1::uuid[])) OR t.result_request_id IN(SELECT id FROM public.veo_telegram_intake_requests WHERE actor_id=ANY($1::uuid[]))");
 const fks=(await db.query(`SELECT s.relname child,r.relname parent,c.conname,ta.attname column_name,ns.nspname schema_name
 FROM pg_constraint c JOIN pg_class s ON s.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=s.relnamespace JOIN pg_class r ON r.oid=c.confrelid
 JOIN LATERAL unnest(c.conkey) k(att) ON true JOIN pg_attribute ta ON ta.attrelid=s.oid AND ta.attnum=k.att
 WHERE c.contype='f' AND c.confrelid IN(SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)`)).rows;
 const blockers=[];
 for(const f of fks.filter(f=>rootTables.includes(f.parent)&&!rules.has(f.child))){
  const selected=f.parent==='veo_teams'?teams:ids;
  const count=(await db.query(`SELECT count(*)::int n FROM ${ident(f.schema_name)}.${ident(f.child)} WHERE ${ident(f.column_name)}=ANY($1::uuid[])`,[selected])).rows[0].n;
  if(count)blockers.push({table:f.child,column:f.column_name,rows:count});
 }
 const counts={};for(const [table,where] of rules)counts[table]=(await query(db,`SELECT count(*)::int n FROM public.${ident(table)} t WHERE ${where}`,p)).rows[0].n;
 // Unknown embedded staff IDs are a blocker, never a reason to erase a
 // customer, Page, chatbot document or financial record implicitly.
 if(ids.length){
  const sql=tables.filter(t=>!rules.has(t)).map(t=>`SELECT '${t}' table_name,count(*)::int rows FROM public.${ident(t)} t WHERE to_jsonb(t)::text ~ array_to_string($1::uuid[]||$2::uuid[],'|') HAVING count(*)>0`).join(' UNION ALL ');
  if(sql)for(const row of(await query(db,sql,p)).rows)blockers.push({table:row.table_name,rows:row.rows,embeddedStaffReference:true});
 }
 const order=[],pending=new Set(rules.keys());
 while(pending.size){const ready=[...pending].filter(t=>!fks.some(f=>f.parent===t&&f.child!==t&&pending.has(f.child)));
  assert(ready.length,'Workforce dependency cycle requires review');for(const t of ready.sort()){order.push(t);pending.delete(t);}
 }
 const plan={owner,tenant,staff:staff.map(({user_id,role,parent_id,active})=>({id:user_id,role,parent_id,active})),teams,counts,blockers};
 const fingerprint=createHash('sha256').update(JSON.stringify({owner,tenant,staff:plan.staff,teams})).digest('hex');
 return {plan:{...plan,fingerprint},p,tables,rules,order,fks};
}
export async function protectedWorkforceSnapshot(db,context){
 const sql=context.tables.map(t=>{const value=context.normalize?.[t]||'to_jsonb(t)';return `SELECT '${t}' table_name,count(*)::int rows,md5(coalesce(string_agg(md5((${value})::text),'' ORDER BY md5((${value})::text)),'')) fingerprint FROM public.${ident(t)} t WHERE NOT(coalesce((${context.rules.get(t)||'false'}),false))`;}).join(' UNION ALL ');
 return (await query(db,sql,context.p)).rows.sort((a,b)=>a.table_name.localeCompare(b.table_name));
}
export async function applyWorkforceReset(db,context,{backup}){
 assert.equal(context.plan.blockers.length,0,'Protected business records reference this staff; reset refused');
 assert(context.plan.staff.length,'No staff to reset');
 const triggerState=(await db.query("SELECT c.relname table_name,t.tgname,t.tgenabled,p.proname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal ORDER BY c.relname,t.tgname")).rows;
 const before=await protectedWorkforceSnapshot(db,context),rows={};
 for(const [table,where] of context.rules)if(context.plan.counts[table])rows[table]=(await query(db,`SELECT t.* FROM public.${ident(table)} t WHERE ${where}`,context.p)).rows;
 await backup({owner:context.plan.owner,tenant:context.plan.tenant,created_at:new Date().toISOString(),rows});
 const disabled=[];
 for(const [table,name] of Object.entries(guarded)){
  if(!context.plan.counts[table])continue;const trigger=triggerState.find(t=>t.table_name===table&&t.tgname===name);
  assert(trigger?.tgenabled==='O'&&['veo_readonly','veo_freeze_completed_team_capacity'].includes(trigger.proname),'Unexpected workforce retention trigger');
  await db.query(`ALTER TABLE public.${ident(table)} DISABLE TRIGGER ${ident(name)}`);disabled.push({table,name});
 }
 const deleted={};for(const table of context.order){const result=await query(db,`DELETE FROM public.${ident(table)} t WHERE ${context.rules.get(table)}`,context.p);deleted[table]=result.rowCount;}
 for(const {table,name} of disabled)await db.query(`ALTER TABLE public.${ident(table)} ENABLE TRIGGER ${ident(name)}`);
 const afterTriggers=(await db.query("SELECT c.relname table_name,t.tgname,t.tgenabled,p.proname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal ORDER BY c.relname,t.tgname")).rows;assert.deepEqual(afterTriggers,triggerState,'Trigger protections changed');
 assert.deepEqual(await protectedWorkforceSnapshot(db,context),before,'Protected Owner, customer, connection or setup records changed');
 for(const [table,where] of context.rules)assert.equal((await query(db,`SELECT count(*)::int n FROM public.${ident(table)} t WHERE ${where}`,context.p)).rows[0].n,0,`Remaining workforce rows in ${table}`);
 assert.equal((await db.query('SELECT count(*)::int n FROM public.veo_accounts WHERE tenant_id=$1 AND user_id<>$2',[context.plan.tenant,context.plan.owner])).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int n FROM public.veo_teams WHERE tenant_id=$1',[context.plan.tenant])).rows[0].n,0);
 // Keep one non-personal reset receipt after the protected-row comparison.
 await db.query("INSERT INTO public.veo_audit(tenant_id,actor_id,action,entity_id,after_value,reason) VALUES($1,$2,'workforce_fresh_start',$1,$3::jsonb,'Owner explicitly requested deletion of all staff accounts and workforce setup')",[context.plan.tenant,context.plan.owner,JSON.stringify({accounts:deleted.veo_accounts,teams:deleted.veo_teams,customer_records_changed:0})]);
 return {deleted,ownerAndBusinessDataPreserved:true,triggerProtectionsRestored:true,remainingStaffAccounts:0,remainingTeams:0};
}
