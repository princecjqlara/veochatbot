import {describe,it,expect} from 'vitest';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {gzipSync} from 'node:zlib';import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';import {vector} from '@electric-sql/pglite-pgvector';
import {importColumnPlan,importDependencyOrder,importMigrationTable,verifyImportedTable,legacyContactNamePreservationSql,preserveLegacyContactNames,rawJsonCopyOptions,resetImportedIdentitySequences} from '../../../scripts/lib/migration-import.mjs';
describe('isolated account data import',()=>{
 it('preserves only preexisting placeholder names and still rejects new invalid names',async()=>{
  const db=new PGlite(),query=async(sql:string,args?:any[])=>args?db.query<any>(sql,args):(await db.exec(sql)).at(-1)||{rows:[]};
  try{
   await db.exec("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA app_private;CREATE TABLE contacts(id uuid PRIMARY KEY,name text,stage text,CONSTRAINT contacts_name_not_placeholder CHECK(name IS NULL OR lower(name)!='facebook user'));");
   await db.exec(legacyContactNamePreservationSql);
   const old='00000000-0000-4000-8000-000000000001',fresh='00000000-0000-4000-8000-000000000002';
   await preserveLegacyContactNames({query},JSON.stringify([{id:old,name:'Facebook User',stage:'new'}]));
   await db.query('INSERT INTO contacts VALUES($1,$2,$3)',[old,'Facebook User','new']);
   await db.query('UPDATE contacts SET stage=$2 WHERE id=$1',[old,'converted']);
   expect((await db.query<any>('SELECT name,stage FROM contacts')).rows[0]).toEqual({name:'Facebook User',stage:'converted'});
   await expect(db.query('INSERT INTO contacts VALUES($1,$2,$3)',[fresh,'Facebook User','new'])).rejects.toThrow('contacts_name_not_placeholder');
  }finally{await db.close();}
 },30000);
 it('requires parents before children and refuses unsupported nonempty tables or changed source types',()=>{
  const tables=[{name:'child',rows:1},{name:'parent',rows:1}];
  expect(importDependencyOrder(tables,[{child:'child',parent:'parent',parent_schema:'public'}]).map((t:any)=>t.name)).toEqual(['parent','child']);
  expect(()=>importDependencyOrder(tables,[{child:'child',parent:'parent',parent_schema:'public'},{child:'parent',parent:'child',parent_schema:'public'}])).toThrow('Cyclic');
  const source=[{table_name:'users',column_name:'session_version',sql_type:'integer'}];
  expect(importColumnPlan(source,[{table_name:'users',column_name:'id',sql_type:'uuid'}],[{name:'users',rows:1,columns:['session_version']}])).toEqual([expect.objectContaining({column:'session_version',definition:'integer DEFAULT 0 NOT NULL'})]);
  expect(()=>importColumnPlan(source,[],[{name:'users',rows:1,columns:['session_version']}])).toThrow('Nonempty');
  expect(()=>importColumnPlan([{...source[0],sql_type:'text'}],[{table_name:'users',column_name:'id',sql_type:'uuid'}],[{name:'users',rows:1,columns:['session_version']}])).toThrow('Unsupported');
 });
 it('preserves prompts, nulls, timestamps, exact amounts and vectors while suppressing import side effects',async()=>{
  const db=await PGlite.create({extensions:{vector}}),directory=fs.mkdtempSync(path.join(os.tmpdir(),'veobot-import-'));
  const query=async(sql:string,args?:any[])=>args?db.query<any>(sql,args):(await db.exec(sql)).at(-1)||{rows:[]};
  try{
   await db.exec(`CREATE EXTENSION vector;CREATE TABLE setups(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,instructions text,enabled boolean,amount bigint,embedding vector(3),updated_at timestamptz,note text);
    CREATE TABLE effects(id integer);CREATE FUNCTION changed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO effects VALUES(NEW.id);NEW.instructions='changed by trigger';RETURN NEW;END; $$;
    CREATE TRIGGER policy BEFORE INSERT ON setups FOR EACH ROW EXECUTE FUNCTION changed();
    SET timezone='UTC';SET extra_float_digits=3;`);
   await db.exec('BEGIN;ALTER TABLE setups DISABLE TRIGGER USER;');
   const raw=(await db.query<any>(`SELECT to_jsonb(t)::text AS row FROM (SELECT 1 AS id,'Keep exact\nflow'::text AS instructions,true AS enabled,9007199254740993::bigint AS amount,'[0.1,0.2,0.3]'::vector(3) AS embedding,'2026-10-01T03:04:05.123456Z'::timestamptz AS updated_at,NULL::text AS note)t`)).rows[0].row;
   const item={name:'setups',file:'setups.jsonl.gz',columns:['id','instructions','enabled','amount','embedding','updated_at','note'],primary_key:['id'],rows:1,sha256:createHash('sha256').update(raw+'\n').digest('hex')};
   fs.writeFileSync(path.join(directory,item.file),gzipSync(raw+'\n'));
   const result=await importMigrationTable({query},directory,item);
   expect(await verifyImportedTable({query},item,result)).toMatchObject({identical:true,rows:1});
   expect((await db.query<any>('SELECT count(*)::int AS n FROM effects')).rows[0].n).toBe(0);
   expect((await db.query<any>('SELECT amount::text AS amount,instructions,note FROM setups')).rows[0]).toEqual({amount:'9007199254740993',instructions:'Keep exact\nflow',note:null});
   await db.exec('CREATE TEMP TABLE copy_stage(payload jsonb)');
   await db.exec("COPY copy_stage(payload) FROM '/dev/blob' "+rawJsonCopyOptions,{blob:new Blob([raw+'\n'])});
   expect((await db.query<any>('SELECT payload::text AS row FROM copy_stage')).rows[0].row).toBe(raw);
   await resetImportedIdentitySequences({query},item,[{table_name:'setups',column_name:'id',identity:'a'}]);
   await db.exec('ALTER TABLE setups ENABLE TRIGGER policy;ROLLBACK;');
   expect((await db.query<any>('SELECT count(*)::int AS n FROM setups')).rows[0].n).toBe(0);
   await db.exec("INSERT INTO setups(instructions) VALUES('new');");
   expect((await db.query<any>('SELECT instructions FROM setups')).rows[0].instructions).toBe('changed by trigger');
  }finally{await db.close();fs.rmSync(directory,{recursive:true,force:true});}
 },30000);
});
