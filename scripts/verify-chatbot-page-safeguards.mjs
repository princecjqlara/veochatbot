// Installs an additive migration with --apply. Database fixtures remain inside a
// savepoint and are rolled back; no Messenger endpoints are called.
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);const {Pool}=require('pg');
const apply=process.argv.includes('--apply');
const pool=new Pool({connectionString:process.env.DATABASE_POOLER_URL_5432||process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:1,connectionTimeoutMillis:15000});
const report={at:new Date().toISOString(),apply,tests:[],noCustomerMessagesSent:true,fixturesRolledBack:false};
const client=await pool.connect();
const expect=(condition,label)=>{if(!condition)throw new Error(label);report.tests.push(label);};
try{
 await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='30s'");await client.query("SET LOCAL lock_timeout='5s'");
 report.before=(await client.query("SELECT pg_get_functiondef(oid) AS definition FROM pg_proc WHERE oid=to_regprocedure('public.repair_chatbot_page_outcome_tags(uuid,integer)')")).rows;
 await writeFile(new URL('../../data/lead-stage-prevention-migration-before.json',import.meta.url),JSON.stringify({at:report.at,before:report.before},null,2));
 await client.query(await readFile(new URL('../supabase/migrations/202610140001_chatbot_page_safeguards.sql',import.meta.url),'utf8'));
 const permissions=(await client.query("SELECT has_function_privilege('service_role','public.repair_chatbot_page_outcome_tags(uuid,integer)','EXECUTE') AS service,has_function_privilege('anon','public.repair_chatbot_page_outcome_tags(uuid,integer)','EXECUTE') AS anon,has_function_privilege('authenticated','public.repair_chatbot_page_outcome_tags(uuid,integer)','EXECUTE') AS authenticated")).rows[0];
 expect(permissions.service&&!permissions.anon&&!permissions.authenticated,'recovery RPC is restricted to service_role');
 await client.query('SAVEPOINT fixtures');
 const page=randomUUID(),otherPage=randomUUID();
 for(const id of [page,otherPage])await client.query("INSERT INTO pages(id,fb_page_id,name,access_token,messaging_auto_tag_enabled) VALUES($1,$2,'Safeguard rollback fixture','unused',FALSE)",[id,`fixture-${id}`]);
 await client.query('INSERT INTO chatbot_configs(page_id,enabled) VALUES($1,TRUE),($2,TRUE)',[page,otherPage]);
 const stages=['qualified','not_qualified','converted','order_created'];
 const ids=[];
 for(const stage of stages){const id=randomUUID();ids.push(id);await client.query("INSERT INTO contacts(id,page_id,psid,pipeline_stage,pipeline_stage_source) VALUES($1,$2,$3,$4,'messenger')",[id,page,`fixture-${id}`,stage]);}
 const chatbot=randomUUID(),other=randomUUID();
 await client.query("INSERT INTO contacts(id,page_id,psid,pipeline_stage,pipeline_stage_source) VALUES($1,$2,$3,'qualified','chatbot'),($4,$5,$6,'qualified','messenger')",[chatbot,page,`fixture-${chatbot}`,other,otherPage,`fixture-${other}`]);
 const repair=async limit=>Number((await client.query('SELECT repair_chatbot_page_outcome_tags($1,$2) AS added',[page,limit])).rows[0].added);
 expect(await repair(2)===2,'first recovery respects its batch limit');
 expect(await repair(2)===2,'later recovery completes remaining saved outcomes');
 expect(await repair(250)===0,'repeat recovery is idempotent');
 const assignments=(await client.query('SELECT ct.contact_id,t.system_key,t.owner_id FROM contact_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.contact_id=ANY($1::uuid[])',[ids])).rows;
 expect(assignments.length===4&&assignments.every(a=>a.owner_id===page&&stages.includes(a.system_key)),'recovery assigns the correct outcome on the owning Page');
 const excluded=(await client.query('SELECT COUNT(*)::INTEGER AS count FROM contact_tags WHERE contact_id=ANY($1::uuid[])',[[chatbot,other]])).rows[0].count;
 expect(excluded===0,'recovery excludes other Pages and chatbot-owned stages');
 await client.query('UPDATE chatbot_configs SET enabled=FALSE WHERE page_id=$1',[otherPage]);
 expect(Number((await client.query('SELECT repair_chatbot_page_outcome_tags($1,250) AS added',[otherPage])).rows[0].added)===0,'recovery skips disabled chatbot Pages');
 await client.query('SAVEPOINT invalid_limit');let invalid=false;
 try{await repair(1001);}catch(e){invalid=/p_limit must be/.test(e.message);}
 await client.query('ROLLBACK TO SAVEPOINT invalid_limit');expect(invalid,'invalid recovery limits are rejected');
 await client.query('ROLLBACK TO SAVEPOINT fixtures');report.fixturesRolledBack=true;
 await client.query(apply?'COMMIT':'ROLLBACK');report.committed=apply;
 console.log(JSON.stringify(report));
}catch(e){await client.query('ROLLBACK');report.error=e.message;process.exitCode=1;console.log(JSON.stringify(report));}
finally{client.release();await pool.end();await writeFile(new URL('../../data/lead-stage-prevention-migration.json',import.meta.url),JSON.stringify(report,null,2));}
