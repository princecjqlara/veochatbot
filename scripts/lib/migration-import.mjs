import fs from 'node:fs';import path from 'node:path';import {createGunzip} from 'node:zlib';import {createInterface} from 'node:readline';import {createHash} from 'node:crypto';
import {sqlIdentifier as ident} from './database-migration-safety.mjs';
import {from as copyFrom} from 'pg-copy-streams';import {Readable} from 'node:stream';import {pipeline} from 'node:stream/promises';

const validName=name=>`(${name} IS NULL OR (btrim(${name})<>'' AND lower(btrim(${name})) NOT IN ('unknown','unknown name','unknown user','facebook user','messenger contact','undefined','null')))`;
export const legacyContactNamePreservationSql=`CREATE TABLE IF NOT EXISTS app_private.veobot_legacy_contact_names(contact_id uuid PRIMARY KEY,name text NOT NULL);
 REVOKE ALL ON app_private.veobot_legacy_contact_names FROM PUBLIC,anon,authenticated;
 CREATE OR REPLACE FUNCTION app_private.veobot_preserved_contact_name(p_id uuid,p_name text) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $$
 SELECT EXISTS(SELECT 1 FROM app_private.veobot_legacy_contact_names WHERE contact_id=p_id AND name IS NOT DISTINCT FROM p_name) $$;
 REVOKE ALL ON FUNCTION app_private.veobot_preserved_contact_name(uuid,text) FROM PUBLIC,anon,authenticated;
 GRANT EXECUTE ON FUNCTION app_private.veobot_preserved_contact_name(uuid,text) TO service_role;
 ALTER TABLE public.contacts DROP CONSTRAINT contacts_name_not_placeholder;
 ALTER TABLE public.contacts ADD CONSTRAINT contacts_name_not_placeholder CHECK(${validName('name')} OR app_private.veobot_preserved_contact_name(id,name))`;
export async function preserveLegacyContactNames(db,json){
 await db.query(`INSERT INTO app_private.veobot_legacy_contact_names(contact_id,name)
 SELECT t.id,t.name FROM jsonb_populate_recordset(NULL::public.contacts,$1::jsonb) t WHERE NOT ${validName('t.name')}
 ON CONFLICT(contact_id) DO UPDATE SET name=EXCLUDED.name`,[json]);
}

// These legacy fields have no runtime policy attached in VeoBot. Preserve their
// original values instead of silently dropping them or copying Tokko auth code.
export const legacyPreservationColumns={
 pages:{campaign_delivery_owner:'uuid',campaign_delivery_lease_until:'timestamp with time zone',campaign_delivery_cooldown_until:'timestamp with time zone',campaign_delivery_rate_strikes:'integer DEFAULT 0 NOT NULL',campaign_delivery_last_rate_limit_at:'timestamp with time zone',messaging_auto_tag_owner:'uuid'},
 user_pages:{grant_source:"text DEFAULT 'legacy' NOT NULL",granted_by:'uuid'},
 users:{email_login_enabled:'boolean DEFAULT false NOT NULL',email_verified_at:'timestamp with time zone',password_changed_at:'timestamp with time zone',session_version:'integer DEFAULT 0 NOT NULL',account_kind:"text DEFAULT 'legacy' NOT NULL",created_by:'uuid',expires_at:'timestamp with time zone',delete_after_expiry:'boolean DEFAULT false NOT NULL',phone_number:'text',profile_required:'boolean DEFAULT false NOT NULL',profile_completed_at:'timestamp with time zone'}
};
export function importColumnPlan(source,target,tables){
 const changes=[];
 for(const item of tables){
  const fields=target.filter(c=>c.table_name===item.name);
  if(!fields.length){if(item.rows!==0)throw Error('Nonempty source table is unsupported: '+item.name);continue;}
  for(const name of item.columns){
   const original=source.find(c=>c.table_name===item.name&&c.column_name===name),other=fields.find(c=>c.column_name===name);
   if(!original)throw Error('Source column metadata is missing');
   if(other){if(other.sql_type!==original.sql_type)throw Error('Source type differs: '+item.name+'.'+name);continue;}
   const definition=legacyPreservationColumns[item.name]?.[name];
   if(!definition || definition.split(' DEFAULT ')[0]!==original.sql_type)throw Error('Unsupported source column: '+item.name+'.'+name);
   changes.push({table:item.name,column:name,definition,sql:`ALTER TABLE public.${ident(item.name)} ADD COLUMN ${ident(name)} ${definition}`});
  }
 }
 return changes;
}
export function importDependencyOrder(tables,foreignKeys){
 const names=new Set(tables.map(t=>t.name)),remaining=new Map(tables.map(t=>[t.name,t])),ordered=[];
 while(remaining.size){
  const available=[...remaining.values()].filter(t=>!foreignKeys.some(f=>f.child===t.name&&f.parent_schema==='public'&&f.parent!==t.name&&names.has(f.parent)&&remaining.has(f.parent)))
   .sort((a,b)=>Number(a.rows>=100000)-Number(b.rows>=100000)||(a.rows||0)-(b.rows||0)||a.name.localeCompare(b.name)).slice(0,1);
  if(!available.length)throw Error('Cyclic table dependencies require explicit handling');
  for(const t of available){ordered.push(t);remaining.delete(t.name);}
 }
 return ordered;
}
export async function* migrationBackupLines(directory,item){
 if(item.file!==item.name+'.jsonl.gz')throw Error('Unexpected source artifact path');
 const stream=fs.createReadStream(path.join(directory,item.file)),gunzip=createGunzip();stream.on('error',e=>gunzip.destroy(e));stream.pipe(gunzip);
 const lines=createInterface({input:gunzip,crlfDelay:Infinity});
 try{for await(const line of lines){if(!line)throw Error('Empty source JSON record');yield line;}}
 finally{lines.close();stream.destroy();gunzip.destroy();}
}
export async function importMigrationTable(db,directory,item,progress=()=>{},beforeInsert=async()=>{}){
 const columns=item.columns.map(ident).join(','),rawHash=createHash('sha256'),rowHash=createHash('sha256');let rows=0,batch=[],bytes=0;
 const flush=async()=>{if(!batch.length)return;const json='['+batch.join(',')+']';await beforeInsert(json);await db.query(`INSERT INTO public.${ident(item.name)}(${columns}) OVERRIDING SYSTEM VALUE SELECT ${columns} FROM jsonb_populate_recordset(NULL::public.${ident(item.name)},$1::jsonb)`,[json]);batch=[];bytes=0;progress(rows);};
 for await(const line of migrationBackupLines(directory,item)){
  rawHash.update(line+'\n');rowHash.update(createHash('sha256').update(line).digest('hex')+'\n');rows++;batch.push(line);bytes+=Buffer.byteLength(line);
  if(batch.length>=1000||bytes>=512*1024)await flush();
 }
 await flush();
 if(rows!==item.rows||rawHash.digest('hex')!==item.sha256)throw Error('Source artifact changed during import: '+item.name);
 return {table:item.name,rows,source_sha256:item.sha256,row_fingerprint_sha256:rowHash.digest('hex')};
}
export const rawJsonCopyOptions="WITH (FORMAT csv,DELIMITER E'\\x02',QUOTE E'\\x01',ESCAPE E'\\x01')";
export async function importMigrationTableCopy(db,directory,item,progress=()=>{}){
 const columns=item.columns.map(ident).join(','),rawHash=createHash('sha256'),rowHash=createHash('sha256');let rows=0,batch=[],bytes=0;
 await db.query('CREATE TEMP TABLE veobot_import_stage(payload jsonb) ON COMMIT DROP');
 const flush=async()=>{
  if(!batch.length)return;
  const output=db.query(copyFrom('COPY pg_temp.veobot_import_stage(payload) FROM STDIN '+rawJsonCopyOptions));
  await pipeline(Readable.from(batch.map(line=>line+'\n')),output);
  if(item.name==='contacts')await db.query(`INSERT INTO app_private.veobot_legacy_contact_names(contact_id,name) SELECT r.id,r.name FROM pg_temp.veobot_import_stage s CROSS JOIN LATERAL jsonb_populate_record(NULL::public.contacts,s.payload) r WHERE NOT ${validName('r.name')} ON CONFLICT(contact_id) DO UPDATE SET name=EXCLUDED.name`);
  await db.query(`INSERT INTO public.${ident(item.name)}(${columns}) OVERRIDING SYSTEM VALUE SELECT ${item.columns.map(c=>'r.'+ident(c)).join(',')} FROM pg_temp.veobot_import_stage s CROSS JOIN LATERAL jsonb_populate_record(NULL::public.${ident(item.name)},s.payload) r`);
  await db.query('TRUNCATE pg_temp.veobot_import_stage');batch=[];bytes=0;progress(rows);
 };
 for await(const line of migrationBackupLines(directory,item)){
  if(/[\x01\x02\r\n]/.test(line))throw Error('Unexpected literal control character in canonical PostgreSQL JSON');
  rawHash.update(line+'\n');rowHash.update(createHash('sha256').update(line).digest('hex')+'\n');rows++;batch.push(line);bytes+=Buffer.byteLength(line);
  if(batch.length>=20000||bytes>=16*1024*1024)await flush();
 }
 await flush();await db.query('DROP TABLE pg_temp.veobot_import_stage');
 if(rows!==item.rows||rawHash.digest('hex')!==item.sha256)throw Error('Source artifact changed during COPY: '+item.name);
 return {table:item.name,rows,source_sha256:item.sha256,row_fingerprint_sha256:rowHash.digest('hex')};
}
export async function resetImportedIdentitySequences(db,item,metadata){
 for(const column of metadata.filter(c=>c.table_name===item.name&&c.identity)){
  const sequence=(await db.query('SELECT pg_get_serial_sequence($1,$2) AS name',['public.'+ident(item.name),column.column_name])).rows[0].name;
  if(sequence)await db.query(`SELECT setval($1::regclass,GREATEST(1,COALESCE(max(${ident(column.column_name)}),0)),max(${ident(column.column_name)}) IS NOT NULL) FROM public.${ident(item.name)}`,[sequence]);
 }
}
export async function verifyImportedTable(db,item,expected,progress=()=>{}){
 const columns=item.columns.map(c=>'t.'+ident(c)).join(','),order=item.primary_key.map(c=>'t.'+ident(c)).join(','),hash=createHash('sha256');let rows=0;
 await db.query(`DECLARE veobot_import_verify NO SCROLL CURSOR FOR SELECT encode(sha256(convert_to(to_jsonb(original)::text,'UTF8')),'hex') AS fingerprint FROM (SELECT ${columns} FROM public.${ident(item.name)} t ORDER BY ${order}) original`);
 for(;;){const batch=await db.query('FETCH FORWARD 10000 FROM veobot_import_verify');if(!batch.rows.length)break;for(const record of batch.rows){hash.update(record.fingerprint+'\n');rows++;}progress(rows);}
 await db.query('CLOSE veobot_import_verify');const fingerprint=hash.digest('hex');
 if(rows!==expected.rows||fingerprint!==expected.row_fingerprint_sha256)throw Error('Destination row values differ: '+item.name);
 return {table:item.name,rows,row_fingerprint_sha256:fingerprint,identical:true};
}
