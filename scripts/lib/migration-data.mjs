import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { LEGACY_SOURCE_PROJECT, VEO_TARGET_PROJECT, sqlIdentifier as ident } from './database-migration-safety.mjs';

const table = name => 'public.' + ident(name);
export const isChatbotPreservationTable = name => name.startsWith('chatbot_') ||
 ['welcome_messages','workflow_automations','workflow_automation_states','contact_bot_permission_events'].includes(name);
export const migrationMetadataSql = `SELECT c.relname AS table_name,c.relkind,
 a.attname AS column_name,format_type(a.atttypid,a.atttypmod) AS sql_type,
 a.attgenerated AS generated,a.attidentity AS identity,a.attnum,
 EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary AND a.attnum=ANY(i.indkey)) AS primary_key
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
 WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') ORDER BY c.relname,a.attnum`;
export const migrationForeignKeysSql = `SELECT c.conname AS name,
 cn.nspname AS child_schema,cc.relname AS child,pn.nspname AS parent_schema,pc.relname AS parent,
 ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum,position)
 JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.position)::text[] AS child_columns,
 ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(attnum,position)
 JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.position)::text[] AS parent_columns
 FROM pg_constraint c JOIN pg_class cc ON cc.oid=c.conrelid JOIN pg_namespace cn ON cn.oid=cc.relnamespace
 JOIN pg_class pc ON pc.oid=c.confrelid JOIN pg_namespace pn ON pn.oid=pc.relnamespace
 WHERE c.contype='f' AND cn.nspname='public' ORDER BY cc.relname,c.conname`;

/** Account-scoped preservation. A Page's expired token does not erase its setup.
 * This plan is a backup scope, not authorization to activate a different Meta app.
 * Unknown tables stop the backup; application-specific Tokko account tables are
 * explicitly excluded rather than copied into VeoBot's authentication system.
 */
export function migrationDataPlan(columns, foreignKeys, options = {}) {
 const groups = new Map();
 for (const column of columns) {
  ident(column.table_name); ident(column.column_name);
  if (!groups.has(column.table_name)) groups.set(column.table_name, []);
  groups.get(column.table_name).push(column);
 }
 for (const required of ['pages','users','user_pages','contacts','tags','contact_tags','campaigns',
  'businesses','business_users','chatbot_configs','chatbot_pricing_experiments','chatbot_pricing_packages','chatbot_pricing_assignments','workflow_automations'])
  if (!groups.has(required)) throw Error('Source scope dependency is missing: ' + required);
 const excluded = [], views = [], tables = [];
 for (const [name, fields] of groups) {
  if (['v','m'].includes(fields[0].relkind)) { views.push(name); continue; }
  if (name.startsWith('tokko_')) { excluded.push({ table: name, reason: 'Separate Tokko account/authentication system' }); continue; }
  const primary = fields.filter(field => field.primary_key).map(field => field.column_name);
  if (!primary.length) throw Error('A stable source primary key is required: ' + name);
  tables.push({ name, columns: fields, primary_key: primary });
 }
 const names = new Set(tables.map(t => t.name));
 const simple = (name, alias = 't') => {
  const q = ident(alias), fields = groups.get(name);
  if (name === 'pages') return `${q}.id=ANY($1::uuid[])`;
  if (fields?.some(field => field.column_name === 'page_id')) return `${q}.page_id=ANY($1::uuid[])`;
  const via = {
   contact_tags: ['contact_id','contacts'],
   campaign_recipients: ['campaign_id','campaigns'], campaign_delivery_failures: ['campaign_id','campaigns'],
   chatbot_pricing_packages: ['experiment_id','chatbot_pricing_experiments'],
   chatbot_pricing_deliveries: ['assignment_id','chatbot_pricing_assignments'],
   chatbot_pricing_outcomes: ['assignment_id','chatbot_pricing_assignments'],
   workflow_automation_states: ['automation_id','workflow_automations']
  }[name];
  if (via) return `${q}.${ident(via[0])} IN (SELECT id FROM ${table(via[1])} WHERE page_id=ANY($1::uuid[]))`;
  if (name === 'ad_tracking_settings') return 'TRUE'; // Shared singleton: archive, never activate implicitly.
  return null;
 };
 const pageBusiness = `SELECT business_id FROM public.pages WHERE id=ANY($1::uuid[]) AND business_id IS NOT NULL`;
 const pageUsers = `SELECT user_id FROM public.user_pages WHERE page_id=ANY($1::uuid[]) UNION SELECT $2::uuid`;
 const referencedTags = `SELECT ct.tag_id FROM public.contact_tags ct JOIN public.contacts c ON c.id=ct.contact_id WHERE c.page_id=ANY($1::uuid[])
  UNION SELECT p.tag_id FROM public.chatbot_pricing_packages p JOIN public.chatbot_pricing_experiments e ON e.id=p.experiment_id WHERE e.page_id=ANY($1::uuid[]) AND p.tag_id IS NOT NULL
  UNION SELECT v.value::uuid FROM public.campaigns c CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(c.audience_include_tag_ids,'[]')||COALESCE(c.audience_exclude_tag_ids,'[]')) v(value) WHERE c.page_id=ANY($1::uuid[])`;
 const tagScope = alias => `${ident(alias)}.page_id=ANY($1::uuid[]) OR ${ident(alias)}.id IN (${referencedTags})
  OR (${ident(alias)}.page_id IS NULL AND ((${ident(alias)}.owner_type='user' AND ${ident(alias)}.owner_id IN (${pageUsers}))
  OR (${ident(alias)}.owner_type='business' AND ${ident(alias)}.owner_id IN (${pageBusiness}))
  OR (${ident(alias)}.owner_type='page' AND ${ident(alias)}.owner_id=ANY($1::uuid[]))))`;
 const businessScope = `id IN (${pageBusiness} UNION SELECT owner_id FROM public.tags t WHERE t.owner_type='business' AND (${tagScope('t')}))`;
 const baseFilter = (name, alias = 't') => {
  if (name === 'tags') return tagScope(alias);
  if (name === 'tag_shares') return `${ident(alias)}.tag_id IN (SELECT id FROM public.tags tag WHERE ${tagScope('tag')})`;
  if (name === 'businesses') return `${ident(alias)}.id IN (SELECT id FROM public.businesses WHERE ${businessScope})`;
  if (name === 'business_users') return `${ident(alias)}.business_id IN (SELECT id FROM public.businesses WHERE ${businessScope})`;
  return simple(name, alias);
 };
 const userReferences = options.focus==='chatbot' ? [pageUsers] : [pageUsers, `SELECT owner_id FROM public.tags t WHERE t.owner_type='user' AND (${tagScope('t')})`];
 for (const fk of foreignKeys) {
  if (fk.parent_schema !== 'public' || fk.parent !== 'users' || !names.has(fk.child) || fk.child === 'users') continue;
  if(options.focus==='chatbot' && !isChatbotPreservationTable(fk.child))continue;
  if (fk.child_columns.length !== 1 || fk.parent_columns.join(',') !== 'id') throw Error('Unsupported account reference: ' + fk.name);
  const filter = baseFilter(fk.child);
  if (!filter) throw Error('Unknown source table scope: ' + fk.child);
  userReferences.push(`SELECT t.${ident(fk.child_columns[0])} FROM ${table(fk.child)} t WHERE (${filter}) AND t.${ident(fk.child_columns[0])} IS NOT NULL`);
 }
 const hasCreator = groups.get('users').some(c => c.column_name === 'created_by');
 const userScope = `WITH RECURSIVE account_ids(id) AS (SELECT id FROM (${userReferences.join(' UNION ')}) roots(id)
  ${hasCreator ? 'UNION SELECT u.created_by FROM public.users u JOIN account_ids a ON a.id=u.id WHERE u.created_by IS NOT NULL' : ''}) SELECT id FROM account_ids`;
 let cachedUsers=null;
 const filter = (name, alias = 't') => name === 'users' ? (cachedUsers===null ? `${ident(alias)}.id IN (${userScope})` : `${ident(alias)}.id IN (${cachedUsers.length?cachedUsers.map(id=>"'"+id+"'::uuid").join(','):'NULL::uuid'})`) : baseFilter(name, alias);
 for (const item of tables) {
  item.where = filter(item.name);
  if (!item.where) throw Error('Unknown source table scope; retain it for review: ' + item.name);
 }
 return { tables, views, excluded, filter, focus:options.focus||'account', cacheUsers(ids) {
  if(ids.some(id=>!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)))throw Error('Invalid scoped account identity');
  cachedUsers=[...new Set(ids)];
  tables.find(t=>t.name==='users').where=filter('users');
 } };
}

export async function verifyMigrationClosure(db, plan, foreignKeys, parameters, progress = () => {}) {
 const names = new Set(plan.tables.map(t => t.name)), gaps = [];
 for (const fk of foreignKeys) {
  if (!names.has(fk.child)) continue;
  progress(fk);
  if (fk.parent_schema !== 'public' || !names.has(fk.parent)) {
   gaps.push({ table: fk.child, constraint: fk.name, reason: 'Parent table is outside the backup scope' }); continue;
  }
  const child = plan.filter(fk.child, 'c'), parent = plan.filter(fk.parent, 'p');
  const present = fk.child_columns.map(name => 'c.' + ident(name) + ' IS NOT NULL').join(' AND ');
  const match = fk.child_columns.map((name,i) => 'p.' + ident(fk.parent_columns[i]) + '=c.' + ident(name)).join(' AND ');
  const result = await db.query(`SELECT 1 FROM ${table(fk.child)} c WHERE $1::uuid[] IS NOT NULL AND $2::uuid IS NOT NULL AND (${child}) AND ${present}
   AND NOT EXISTS(SELECT 1 FROM ${table(fk.parent)} p WHERE (${parent}) AND ${match}) LIMIT 1`, parameters);
  if (result.rows.length) gaps.push({ table: fk.child, constraint: fk.name, reason: 'Referenced record belongs outside the selected Pages' });
 }
 if(plan.focus==='chatbot')return gaps;
 // Polymorphic tag ownership and campaign audience IDs have no SQL foreign key.
 const tags = plan.filter('tags');
 const extra = await db.query(`SELECT 1 FROM public.tags t WHERE (${tags}) AND
  ((t.owner_type='page' AND NOT(t.owner_id=ANY($1::uuid[]))) OR
   (t.owner_type='user' AND NOT EXISTS(SELECT 1 FROM public.users p WHERE p.id=t.owner_id AND (${plan.filter('users','p')}))) OR
   (t.owner_type='business' AND NOT EXISTS(SELECT 1 FROM public.businesses p WHERE p.id=t.owner_id AND (${plan.filter('businesses','p')})))) LIMIT 1`, parameters);
 if (extra.rows.length) gaps.push({ table: 'tags', reason: 'Tag owner belongs outside the selected scope' });
 const audiences=await db.query(`SELECT 1 FROM public.campaigns c CROSS JOIN LATERAL
  jsonb_array_elements_text(COALESCE(c.audience_include_tag_ids,'[]')||COALESCE(c.audience_exclude_tag_ids,'[]')) v(value)
  WHERE c.page_id=ANY($1::uuid[]) AND $2::uuid IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM public.tags WHERE id=v.value::uuid) LIMIT 1`,parameters);
 if(audiences.rows.length)gaps.push({table:'campaigns',reason:'A campaign audience references a missing tag'});
 return gaps;
}

/** Hash the original PostgreSQL JSON text, without a JSON.parse/stringify round
 * trip that would round large money amounts or discard vector precision. */
export async function verifyMigrationBackup(manifestFile) {
 const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
 if(!manifest.passed || !(manifest.source_backup_completed || (manifest.backup_kind==='chatbot' && manifest.chatbot_backup_completed)) || manifest.source_project!==LEGACY_SOURCE_PROJECT || manifest.target_project!==VEO_TARGET_PROJECT)
  throw Error('A completed source backup for these projects is required');
 if(!manifest.pages?.length || !manifest.tables?.length)throw Error('Backup scope is empty');
 const plan=migrationDataPlan(manifest.columns,manifest.foreign_keys);
 if(manifest.backup_kind && !['account','chatbot'].includes(manifest.backup_kind))throw Error('Unknown backup kind');
 if(manifest.backup_kind==='chatbot' && (manifest.source_backup_completed || !manifest.chatbot_backup_completed))
  throw Error('A chatbot snapshot cannot be marked as a full account backup');
 const selected=plan.tables.filter(t=>manifest.backup_kind!=='chatbot'||isChatbotPreservationTable(t.name));
 const expected=selected.map(t=>t.name).sort(),actual=manifest.tables.map(t=>t.name).sort();
 if(JSON.stringify(expected)!==JSON.stringify(actual))throw Error('Backup is missing a source table or contains a duplicate');
 const directory=path.dirname(path.resolve(manifestFile)),verified=[];
 for(const item of manifest.tables){
  if(item.file!==item.name+'.jsonl.gz')throw Error('Unexpected backup file path');
  const expectedTable=plan.tables.find(t=>t.name===item.name);
  if(JSON.stringify(item.columns)!==JSON.stringify(expectedTable.columns.map(c=>c.column_name)) || JSON.stringify(item.primary_key)!==JSON.stringify(expectedTable.primary_key))
   throw Error('Source column or primary key coverage changed: '+item.name);
  const hash=createHash('sha256');let bytes=0,rows=0,lastByte=null;
  const input=fs.createReadStream(path.join(directory,item.file)),gunzip=createGunzip();
  input.on('error',error=>gunzip.destroy(error));input.pipe(gunzip);
  try {for await(const chunk of gunzip){hash.update(chunk);bytes+=chunk.length;for(const value of chunk)if(value===10)rows++;if(chunk.length)lastByte=chunk[chunk.length-1];}}
  finally{input.destroy();gunzip.destroy();}
  if(hash.digest('hex')!==item.sha256 || bytes!==item.uncompressed_bytes || rows!==item.rows || (bytes>0 && lastByte!==10))
   throw Error('Backup checksum or row count differs: '+item.name);
  verified.push({table:item.name,rows,sha256:item.sha256});
 }
 return {passed:true,run_id:manifest.run_id,backup_kind:manifest.backup_kind||'account',pages:manifest.pages.length,tables:verified,dependency_gaps:manifest.dependency_gaps,
  import_scope_approval_pending:manifest.import_scope_approval_pending===true,verified_at:new Date().toISOString()};
}

export function preservationColumnGaps(sourceColumns, targetColumns, tableNames) {
 const target = new Map(targetColumns.map(c => [c.table_name + '.' + c.column_name, c]));
 const missing = [], changed = [];
 for (const column of sourceColumns.filter(c => tableNames.includes(c.table_name))) {
  const other = target.get(column.table_name + '.' + column.column_name);
  if (!other) missing.push(column.table_name + '.' + column.column_name);
  else if (column.sql_type !== other.sql_type) changed.push(column.table_name + '.' + column.column_name);
 }
 return { missing, changed };
}
