import {randomUUID} from 'node:crypto';
import {backlogPublicationJournalSql} from './backlog-profile-publication.mjs';

export function citedMessages(artifact){
 const ids=new Set();
 const visit=value=>{if(!value||typeof value!=='object')return;for(const [key,item]of Object.entries(value)){
  if(typeof item==='string'&&(/(?:^|_)message_id$/.test(key)||key==='messageId'))ids.add(item);
  else if(key==='message_ids'&&Array.isArray(item)){for(const id of item)if(typeof id==='string')ids.add(id);}
  else if(item&&typeof item==='object')visit(item);
 }};
 visit(artifact.payload);const messages=new Map(artifact.messages.map(m=>[m.id,m]));
 for(const id of ids)if(!messages.has(id))throw Error('A profile refers to a missing source message');
 return artifact.messages.filter(m=>ids.has(m.id));
}
export function localPublicationRow(artifact,identity,normalizeName){
 if(artifact.psid===artifact.facebook_page_id||!artifact.payload.conversation?.customer_message_count)return null;
 const messages=artifact.messages,evidence=citedMessages(artifact),inbound=messages.filter(m=>m.sender==='customer');
 const name=normalizeName(identity?.name);
 return {page_id:artifact.page_id,facebook_page_id:artifact.facebook_page_id,psid:artifact.psid,proposed_id:identity?.id||randomUUID(),name,profile_pic:identity?.profile_pic||null,chatbot_enabled:identity?.chatbot_enabled!==false,
  source_cutoff_at:artifact.source_cutoff_at,source_sha256:artifact.source_sha256,engine:artifact.engine,message_count:messages.length,
  first_inquiry_at:inbound[0].at,last_interaction_at:messages.at(-1).at,last_inbound_at:inbound.at(-1).at,
  payload:{...artifact.payload,source_sha256:artifact.source_sha256,preparation_engine:artifact.engine,raw_history_storage:'local',database_message_storage:'cited_evidence',stored_evidence_message_count:evidence.length},evidence};
}

// Batches commit contact + source evidence + ready profile + receipt together.
// No AI claims, outbound sends, payment creation, or updates to existing controls.
export async function publishLocalBatch(db,rows,apply){
 await db.query('BEGIN');
 try{
  await db.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='90s';SET LOCAL app.historical_lead_repair='deterministic_only'");
  if(!(await db.query("SELECT pg_try_advisory_xact_lock(hashtext('veobot_local_publication')) AS locked")).rows[0].locked)throw Error('Another local publisher is active');
  if(!(await db.query("SELECT pg_try_advisory_xact_lock_shared(hashtext('historical_lead_repair_v2')) AS locked")).rows[0].locked)throw Error('A historical calendar repair is active');
  await db.query(backlogPublicationJournalSql);
  await db.query(`CREATE TEMP TABLE veo_profile_input ON COMMIT DROP AS SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(
   page_id uuid,facebook_page_id text,psid text,proposed_id uuid,name text,profile_pic text,chatbot_enabled boolean,
   source_cutoff_at timestamptz,source_sha256 text,engine text,message_count integer,first_inquiry_at timestamptz,last_interaction_at timestamptz,last_inbound_at timestamptz,payload jsonb,evidence jsonb)`,[JSON.stringify(rows)]);
  if((await db.query('SELECT 1 FROM veo_profile_input i LEFT JOIN pages p ON p.id=i.page_id WHERE p.fb_page_id IS DISTINCT FROM i.facebook_page_id LIMIT 1')).rows.length)throw Error('Prepared history does not belong to a retained VeoBot Page');
  await db.query(`INSERT INTO public.contacts(id,page_id,psid,name,profile_pic,chatbot_enabled,first_interaction_at,last_interaction_at,last_inbound_at,interaction_count,pipeline_stage_updated_at)
   SELECT proposed_id,page_id,psid,name,profile_pic,chatbot_enabled,first_inquiry_at,last_interaction_at,last_inbound_at,message_count,last_interaction_at FROM veo_profile_input
   ON CONFLICT(page_id,psid) DO NOTHING`);
  await db.query(`CREATE TEMP TABLE veo_profile_locked ON COMMIT DROP AS SELECT c.id AS contact_id,i.* FROM veo_profile_input i JOIN contacts c ON c.page_id=i.page_id AND c.psid=i.psid
   WHERE COALESCE(GREATEST(c.last_interaction_at,c.last_inbound_at,c.messenger_stage_event_at),'-infinity'::timestamptz)<=i.source_cutoff_at FOR UPDATE OF c`);
  await db.query(`CREATE TEMP TABLE veo_profile_eligible ON COMMIT DROP AS
   SELECT i.*,GREATEST(1,COALESCE(j.requested_version,1),COALESCE(j.working_version,0)+1,COALESCE(s.generation,0)+1,
    COALESCE((SELECT max(generation) FROM contact_profile_messages m WHERE m.contact_id=i.contact_id),0)+1) AS generation
   FROM veo_profile_locked i LEFT JOIN contact_profile_jobs j ON j.contact_id=i.contact_id
   LEFT JOIN LATERAL(SELECT * FROM contact_profile_snapshots s WHERE s.contact_id=i.contact_id ORDER BY generation DESC LIMIT 1)s ON true
   WHERE NOT EXISTS(SELECT 1 FROM app_private.contact_backlog_publications b WHERE b.contact_id=i.contact_id AND b.engine=i.engine AND b.source_sha256=i.source_sha256)
   AND (s.contact_id IS NULL OR (s.model LIKE 'local-evidence-%' AND s.source_cutoff_at<=i.source_cutoff_at))
   AND NOT (COALESCE(j.status='processing' AND j.lease_until>now(),false))
   AND NOT (COALESCE(j.status IN('queued','failed','processing') AND GREATEST(j.requested_at,j.source_cutoff_at)>i.source_cutoff_at,false))`);
  // Only parser-verified Page stage notices can change pipeline state. The
  // transaction-local flag prevents historical notices from queueing AI reviews.
  await db.query(`DO $$ DECLARE r record; event jsonb; BEGIN
   FOR r IN SELECT * FROM veo_profile_eligible LOOP
    FOR event IN SELECT value FROM jsonb_array_elements(COALESCE(r.payload->'stage_events','[]')) ORDER BY value->>'occurredAt' LOOP
     PERFORM public.apply_messenger_lead_stage(r.page_id,r.contact_id,event->>'messageId',event->>'label',event->>'stage',(event->>'occurredAt')::timestamptz);
    END LOOP;
   END LOOP; END $$`);
  await db.query(`UPDATE contacts c SET pipeline_stage_updated_at=c.messenger_stage_event_at FROM veo_profile_eligible i
   WHERE c.id=i.contact_id AND c.pipeline_stage_source='messenger' AND c.messenger_stage_event_at IS NOT NULL AND c.messenger_stage_event_at<=i.source_cutoff_at`);
  // Older imports may have a contact row but no last-interaction timestamps.
  // Fill only missing fields from complete, Page-verified history; keep newer
  // live values and user-controlled settings intact.
  await db.query(`UPDATE contacts c SET first_interaction_at=COALESCE(c.first_interaction_at,i.first_inquiry_at),
   last_interaction_at=COALESCE(c.last_interaction_at,i.last_interaction_at),last_inbound_at=COALESCE(c.last_inbound_at,i.last_inbound_at),
   interaction_count=GREATEST(COALESCE(c.interaction_count,0),i.message_count)
   FROM veo_profile_eligible i WHERE c.id=i.contact_id AND (c.first_interaction_at IS NULL OR c.last_interaction_at IS NULL OR c.last_inbound_at IS NULL OR COALESCE(c.interaction_count,0)<i.message_count)`);
  await db.query(`INSERT INTO contact_profile_messages(contact_id,page_id,generation,message_id,sent_at,sender,text,attachment_count,image_count)
   SELECT i.contact_id,i.page_id,i.generation,m.id,m.at,m.sender,m.text,m.attachments,coalesce(m.images,0)
   FROM veo_profile_eligible i CROSS JOIN LATERAL jsonb_to_recordset(i.evidence) AS m(id text,at timestamptz,sender text,text text,attachments integer,images integer)`);
  await db.query(`INSERT INTO contact_profile_snapshots(contact_id,page_id,generation,source_cutoff_at,message_count,model,payload)
   SELECT contact_id,page_id,generation,source_cutoff_at,message_count,engine,payload FROM veo_profile_eligible`);
  await db.query(`INSERT INTO contact_profile_jobs(contact_id,page_id,status,reason,requested_version,working_version,source_cutoff_at,scan_started,history_complete,message_count,analyzed_count)
   SELECT contact_id,page_id,'ready','profile_open',generation,generation,source_cutoff_at,true,true,message_count,message_count FROM veo_profile_eligible
   ON CONFLICT(contact_id) DO UPDATE SET status='ready',requested_version=EXCLUDED.requested_version,working_version=EXCLUDED.working_version,
    claim_token=NULL,lease_until=NULL,source_cutoff_at=EXCLUDED.source_cutoff_at,scan_cursor=NULL,scan_started=true,history_complete=true,
    message_count=EXCLUDED.message_count,analyzed_count=EXCLUDED.analyzed_count,partial_analysis='[]',error_message=NULL,attempt_count=0,updated_at=clock_timestamp()`);
  await db.query(`INSERT INTO app_private.contact_backlog_publications(contact_id,page_id,psid,engine,source_sha256,generation,source_cutoff_at)
   SELECT contact_id,page_id,psid,engine,source_sha256,generation,source_cutoff_at FROM veo_profile_eligible`);
  const result=(await db.query('SELECT count(*)::int AS published,coalesce(sum(jsonb_array_length(evidence)),0)::int AS evidence_messages FROM veo_profile_eligible')).rows[0];
  await db.query(apply?'COMMIT':'ROLLBACK');return {...result,considered:rows.length,skipped:rows.length-result.published};
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}
}
