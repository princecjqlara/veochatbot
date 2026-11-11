import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {sqlIdentifier as ident} from './database-migration-safety.mjs';import {protectedWorkforceSnapshot} from './workforce-reset.mjs';
const contentTables={chatbot_knowledge_documents:'update_chatbot_knowledge_documents_updated_at',chatbot_drive_files:'update_chatbot_drive_files_updated_at'};
export async function inspectLegacyAuthors(db,{owner,tenant}){
 const actor=(await db.query('SELECT a.role,a.active,u.is_active,t.owner_id FROM public.veo_accounts a JOIN public.users u ON u.id=a.user_id JOIN public.veo_tenants t ON t.id=a.tenant_id WHERE a.user_id=$1 AND a.tenant_id=$2',[owner,tenant])).rows[0];assert(actor?.role==='owner'&&actor.active&&actor.is_active&&actor.owner_id===owner,'Expected active Owner');
 const staff=(await db.query("SELECT u.id,u.is_active FROM public.users u WHERE u.id<>$1 AND u.is_active=false AND u.email IS NULL AND u.password_hash IS NULL AND NOT EXISTS(SELECT 1 FROM public.veo_accounts a WHERE a.user_id=u.id) ORDER BY u.id",[owner])).rows.map(u=>({id:u.id,role:'legacy_author',active:false})),ids=staff.map(u=>u.id),p=[ids,[],tenant,[]];
 const tables=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(t=>t.tablename),rules=new Map([['users','t.id=ANY($1::uuid[])']]),blockers=[],counts={users:staff.length};
 const fks=(await db.query(`SELECT c.relname table_name,a.attname column_name,n.nspname schema_name FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN LATERAL unnest(f.conkey) k(n) ON true JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.n WHERE f.contype='f' AND f.confrelid='public.users'::regclass`)).rows;
 for(const f of fks){const count=(await db.query(`SELECT count(*)::int n FROM ${ident(f.schema_name)}.${ident(f.table_name)} WHERE ${ident(f.column_name)}=ANY($1::uuid[])`,[ids])).rows[0].n;if(!count)continue;
  if(contentTables[f.table_name]&&f.column_name==='created_by'){
   const outside=(await db.query(`SELECT count(*)::int n FROM public.${ident(f.table_name)} d JOIN public.pages pg ON pg.id=d.page_id WHERE d.created_by=ANY($1::uuid[]) AND pg.veo_tenant_id IS DISTINCT FROM $2`,[ids,tenant])).rows[0].n;
   if(outside)blockers.push({table:f.table_name,outsideWorkspace:outside});counts[f.table_name]=count;
  }else blockers.push({table:f.table_name,column:f.column_name,rows:count});
 }
 if(ids.length){const sql=tables.filter(t=>t!=='users').map(t=>`SELECT '${t}' table_name,count(*)::int rows FROM public.${ident(t)} t WHERE ${(contentTables[t]?"(to_jsonb(t)-'created_by')":"to_jsonb(t)")}::text ~ $1 HAVING count(*)>0`).join(' UNION ALL ');for(const row of(await db.query(sql,[ids.join('|')])).rows)blockers.push({...row,embeddedReference:true});}
 const normalize=Object.fromEntries(Object.keys(contentTables).filter(t=>tables.includes(t)).map(t=>[t,"CASE WHEN t.created_by=ANY($1::uuid[]) OR t.created_by=(SELECT owner_id FROM public.veo_tenants WHERE id=$3) THEN to_jsonb(t)-'created_by' ELSE to_jsonb(t) END"]));
 const fingerprint=createHash('sha256').update(JSON.stringify({owner,tenant,staff})).digest('hex');return {plan:{owner,tenant,staff,teams:[],counts,blockers,fingerprint},p,tables,rules,normalize};
}
export async function applyLegacyAuthorReset(db,context,{backup}){
 assert.equal(context.plan.blockers.length,0,'Legacy author has protected dependencies');assert(context.plan.staff.length,'No unused legacy author identities');
 const ids=context.p[0],before=await protectedWorkforceSnapshot(db,context),rows={users:(await db.query('SELECT * FROM public.users WHERE id=ANY($1::uuid[])',[ids])).rows},original=[];
 for(const [table,trigger] of Object.entries(contentTables))if(context.plan.counts[table]){
  rows[table]=(await db.query(`SELECT * FROM public.${ident(table)} WHERE created_by=ANY($1::uuid[])`,[ids])).rows;
  const state=(await db.query("SELECT g.tgenabled,p.proname FROM pg_trigger g JOIN pg_proc p ON p.oid=g.tgfoid WHERE g.tgrelid=$1::regclass AND g.tgname=$2",['public.'+table,trigger])).rows[0];assert(state?.tgenabled==='O'&&state.proname==='update_updated_at_column','Unexpected content timestamp trigger');original.push({table,trigger});
 }
 await backup({created_at:new Date().toISOString(),owner:context.plan.owner,rows});const transferred={};
 for(const {table,trigger} of original){await db.query(`ALTER TABLE public.${ident(table)} DISABLE TRIGGER ${ident(trigger)}`);transferred[table]=(await db.query(`UPDATE public.${ident(table)} SET created_by=$1 WHERE created_by=ANY($2::uuid[])`,[context.plan.owner,ids])).rowCount;await db.query(`ALTER TABLE public.${ident(table)} ENABLE TRIGGER ${ident(trigger)}`);}
 const deleted=(await db.query('DELETE FROM public.users WHERE id=ANY($1::uuid[])',[ids])).rowCount;assert.equal(deleted,ids.length);assert.deepEqual(await protectedWorkforceSnapshot(db,context),before,'Content or unrelated records changed');
 for(const {table,trigger} of original)assert.equal((await db.query('SELECT tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2',['public.'+table,trigger])).rows[0].tgenabled,'O');
 await db.query("INSERT INTO public.veo_audit(tenant_id,actor_id,action,entity_id,after_value,reason) VALUES($1,$2,'workforce_legacy_authors_cleared',$1,$3::jsonb,'Owner requested removal of unused staff identities; saved chatbot content transferred to Owner')",[context.plan.tenant,context.plan.owner,JSON.stringify({unused_author_identities_deleted:deleted,content_references_transferred:transferred})]);
 return {legacyAuthorsDeleted:deleted,contentReferencesTransferred:transferred,ownerAndBusinessDataPreserved:true,contentAndTimestampsPreserved:true,triggerProtectionsRestored:true};
}
