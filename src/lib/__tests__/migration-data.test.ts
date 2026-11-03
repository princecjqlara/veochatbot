import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { migrationDataPlan, migrationMetadataSql, migrationForeignKeysSql, verifyMigrationClosure, preservationColumnGaps, verifyMigrationBackup } from '../../../scripts/lib/migration-data.mjs';
import { LEGACY_SOURCE_PROJECT, VEO_TARGET_PROJECT } from '../../../scripts/lib/database-migration-safety.mjs';

const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
async function fixture() {
 const db=new PGlite();
 await db.exec(`CREATE TABLE users(id uuid PRIMARY KEY,created_by uuid REFERENCES users(id));
 CREATE TABLE businesses(id uuid PRIMARY KEY);CREATE TABLE business_users(id uuid PRIMARY KEY,business_id uuid REFERENCES businesses(id),user_id uuid REFERENCES users(id));
 CREATE TABLE pages(id uuid PRIMARY KEY,business_id uuid REFERENCES businesses(id));
 CREATE TABLE user_pages(id uuid PRIMARY KEY,page_id uuid REFERENCES pages(id),user_id uuid REFERENCES users(id));
 CREATE TABLE contacts(id uuid PRIMARY KEY,page_id uuid REFERENCES pages(id));
 CREATE TABLE tags(id uuid PRIMARY KEY,page_id uuid REFERENCES pages(id),owner_id uuid,owner_type text);
 CREATE TABLE contact_tags(id uuid PRIMARY KEY,contact_id uuid REFERENCES contacts(id),tag_id uuid REFERENCES tags(id));
 CREATE TABLE tag_shares(id uuid PRIMARY KEY,tag_id uuid REFERENCES tags(id),shared_with_user_id uuid REFERENCES users(id));
 CREATE TABLE campaigns(id uuid PRIMARY KEY,page_id uuid REFERENCES pages(id),audience_include_tag_ids jsonb DEFAULT '[]',audience_exclude_tag_ids jsonb DEFAULT '[]');
 CREATE TABLE chatbot_configs(id uuid PRIMARY KEY,page_id uuid REFERENCES pages(id),knowledge_source_page_id uuid REFERENCES pages(id),instructions text,model text,pricing_enabled boolean,settings jsonb);
 CREATE TABLE chatbot_pricing_experiments(id uuid PRIMARY KEY,page_id uuid REFERENCES pages(id));
 CREATE TABLE chatbot_pricing_packages(id uuid PRIMARY KEY,experiment_id uuid REFERENCES chatbot_pricing_experiments(id),tag_id uuid REFERENCES tags(id));
 CREATE TABLE chatbot_pricing_assignments(id uuid PRIMARY KEY,page_id uuid REFERENCES pages(id));
 CREATE TABLE workflow_automations(id uuid PRIMARY KEY,page_id uuid REFERENCES pages(id));
 CREATE TABLE chatbot_knowledge_documents(id uuid PRIMARY KEY,page_id uuid REFERENCES pages(id),created_by uuid REFERENCES users(id));
 CREATE TABLE tokko_account_tokens(id uuid PRIMARY KEY);
 CREATE VIEW page_summary AS SELECT id FROM pages;
 INSERT INTO users VALUES('${id(1)}',NULL),('${id(2)}',NULL),('${id(3)}','${id(1)}');
 INSERT INTO pages VALUES('${id(11)}',NULL),('${id(12)}',NULL);
 INSERT INTO user_pages VALUES('${id(21)}','${id(11)}','${id(1)}'),('${id(22)}','${id(12)}','${id(2)}');
 INSERT INTO chatbot_configs VALUES('${id(31)}','${id(11)}','${id(12)}','Exact prompt\nKeep this flow','openai/gpt-6-luna',false,'{"follow_up":false,"price":9007199254740993}');
 INSERT INTO chatbot_knowledge_documents VALUES('${id(41)}','${id(11)}','${id(3)}');`);
 const columns=(await db.query<any>(migrationMetadataSql)).rows,foreignKeys=(await db.query<any>(migrationForeignKeysSql)).rows;
 return {db,columns,foreignKeys};
}

describe('complete chatbot migration preservation',()=>{
 it('keeps shared-knowledge dependencies visible and includes original creators without copying another account',async()=>{
  const {db,columns,foreignKeys}=await fixture();
  try {
   const plan=migrationDataPlan(columns,foreignKeys),parameters=[[id(11)],id(1)];
   const users=(await db.query<any>('SELECT t.id FROM users t WHERE ('+plan.filter('users')+')',parameters)).rows.map(r=>r.id).sort();
   expect(users).toEqual([id(1),id(3)]);plan.cacheUsers(users);
   const focused=migrationDataPlan(columns,foreignKeys,{focus:'chatbot'});
   expect((await db.query<any>('SELECT t.id FROM users t WHERE ('+focused.filter('users')+')',parameters)).rows.map(r=>r.id).sort()).toEqual(users);
   expect(plan.views).toContain('page_summary');expect(plan.excluded).toEqual([{table:'tokko_account_tokens',reason:'Separate Tokko account/authentication system'}]);
   const gaps=await verifyMigrationClosure(db,plan,foreignKeys,parameters);
   expect(gaps).toEqual([expect.objectContaining({table:'chatbot_configs',reason:'Referenced record belongs outside the selected Pages'})]);
   const rows=(await db.query<any>(`SELECT to_jsonb(t)::text AS row FROM chatbot_configs t WHERE $2::uuid IS NOT NULL AND (${plan.filter('chatbot_configs')})`,parameters)).rows;
   expect(rows).toHaveLength(1);expect(rows[0].row).toContain('9007199254740993');expect(rows[0].row).toContain('Exact prompt\\nKeep this flow');
   expect(JSON.parse(rows[0].row)).toMatchObject({knowledge_source_page_id:id(12),model:'openai/gpt-6-luna',pricing_enabled:false});
   expect(await verifyMigrationClosure(db,migrationDataPlan(columns,foreignKeys),foreignKeys,[[id(11),id(12)],id(1)])).toEqual([]);
  } finally {await db.close();}
 },30000);
 it('covers future chatbot tables automatically, refuses unknown global tables and detects missing audience tags',async()=>{
  const {db,columns,foreignKeys}=await fixture();
  try {
   const next={table_name:'chatbot_new_settings',column_name:'id',relkind:'r',primary_key:true,sql_type:'uuid'};
   const plan=migrationDataPlan([...columns,next,{...next,column_name:'page_id',primary_key:false}],foreignKeys);
   expect(plan.tables.some(t=>t.name==='chatbot_new_settings')).toBe(true);
   expect(()=>migrationDataPlan([...columns,{...next,table_name:'unknown_global'}],foreignKeys)).toThrow('Unknown source table scope');
   await db.exec(`INSERT INTO campaigns VALUES('${id(51)}','${id(11)}','["${id(99)}"]','[]');`);
   expect(await verifyMigrationClosure(db,plan,foreignKeys,[[id(11),id(12)],id(1)])).toContainEqual({table:'campaigns',reason:'A campaign audience references a missing tag'});
   expect(preservationColumnGaps(columns,columns.filter(c=>c.column_name!=='pricing_enabled'),['chatbot_configs'])).toEqual({missing:['chatbot_configs.pricing_enabled'],changed:[]});
  } finally {await db.close();}
 },30000);
 it('verifies every original JSON byte and rejects altered, incomplete or redirected backups',async()=>{
  const {db,columns,foreignKeys}=await fixture(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'veobot-preserve-'));
  try {
   const plan=migrationDataPlan(columns,foreignKeys),manifest:any={run_id:'test',passed:true,source_backup_completed:true,source_project:LEGACY_SOURCE_PROJECT,target_project:VEO_TARGET_PROJECT,pages:[{id:id(11)},{id:id(12)}],columns,foreign_keys:foreignKeys,dependency_gaps:[],tables:[]};
   for(const item of plan.tables){
    const rows=(await db.query<any>(`SELECT to_jsonb(t)::text AS row FROM "${item.name}" t ORDER BY ${item.primary_key.map((k:string)=>'"'+k+'"').join(',')}`)).rows;
    const raw=rows.map(r=>r.row+'\n').join(''),file=item.name+'.jsonl.gz';fs.writeFileSync(path.join(directory,file),gzipSync(raw));
    manifest.tables.push({name:item.name,file,rows:rows.length,uncompressed_bytes:Buffer.byteLength(raw),sha256:createHash('sha256').update(raw).digest('hex'),columns:item.columns.map((c:any)=>c.column_name),primary_key:item.primary_key});
   }
   const file=path.join(directory,'manifest.json'),save=()=>fs.writeFileSync(file,JSON.stringify(manifest));save();
   expect(await verifyMigrationBackup(file)).toMatchObject({passed:true,pages:2,run_id:'test'});
   const fullTables=manifest.tables;
   manifest.backup_kind='chatbot';manifest.source_backup_completed=false;manifest.chatbot_backup_completed=true;
   manifest.tables=fullTables.filter((t:any)=>t.name.startsWith('chatbot_')||['workflow_automations'].includes(t.name));save();
   expect(await verifyMigrationBackup(file)).toMatchObject({passed:true,backup_kind:'chatbot'});
   manifest.source_backup_completed=true;save();await expect(verifyMigrationBackup(file)).rejects.toThrow('full account backup');
   manifest.backup_kind='account';manifest.tables=fullTables;save();
   const config=manifest.tables.find((t:any)=>t.name==='chatbot_configs');fs.writeFileSync(path.join(directory,config.file),gzipSync('{}\n'));
   await expect(verifyMigrationBackup(file)).rejects.toThrow('checksum');
   config.file='../chatbot_configs.jsonl.gz';save();await expect(verifyMigrationBackup(file)).rejects.toThrow('file path');
   manifest.tables.pop();save();await expect(verifyMigrationBackup(file)).rejects.toThrow('missing a source table');
  } finally {await db.close();fs.rmSync(directory,{recursive:true,force:true});}
 },30000);
});
