export const backlogPublicationJournalSql = `CREATE TABLE IF NOT EXISTS app_private.contact_backlog_publications(
 contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,page_id uuid NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,psid text NOT NULL,
 engine text NOT NULL,source_sha256 text NOT NULL,generation integer NOT NULL,
 source_cutoff_at timestamptz NOT NULL,published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(contact_id,engine,source_sha256));
 REVOKE ALL ON app_private.contact_backlog_publications FROM PUBLIC,anon,authenticated`;

/** The caller verifies artifact/source fingerprints and every citation first.
 * Only the existing profile tables and ready checkpoints are written here. */
export async function publishBacklogProfile(db, artifact, apply = false) {
 const stop = async status => { await db.query('ROLLBACK'); return { status }; };
 await db.query('BEGIN');
 try {
  await db.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'");
  if (!(await db.query("SELECT pg_try_advisory_xact_lock_shared(hashtext('historical_lead_repair_v2')) AS locked")).rows[0].locked) return await stop('calendar_repair_active');
  const contact = (await db.query(`SELECT c.*,p.fb_page_id FROM public.contacts c JOIN public.pages p ON p.id=c.page_id
   WHERE c.page_id=$1 AND c.psid=$2 FOR UPDATE OF c`, [artifact.page_id, artifact.psid])).rows[0];
  if (!contact) return await stop('contact_not_imported');
  if (contact.fb_page_id !== artifact.facebook_page_id) throw Error('Page identity changed before profile publication');
  const cutoff = Date.parse(artifact.source_cutoff_at);
  if ([contact.last_interaction_at, contact.last_inbound_at, contact.messenger_stage_event_at].some(value => value && new Date(value).getTime() > cutoff)) return await stop('fresh_history_needed');
  if (!artifact.messages.length || !artifact.payload.conversation?.customer_message_count) return await stop('no_customer_history');
  await db.query(`INSERT INTO public.contact_profile_jobs(contact_id,page_id,status,reason) VALUES($1,$2,'ready','profile_open') ON CONFLICT(contact_id) DO NOTHING`, [contact.id, contact.page_id]);
  const job = (await db.query('SELECT * FROM public.contact_profile_jobs WHERE contact_id=$1 FOR UPDATE', [contact.id])).rows[0];
  if (job.status === 'processing' && job.lease_until && new Date(job.lease_until).getTime() > Date.now()) return await stop('active_review_retained');
  if (['queued', 'failed', 'processing'].includes(job.status) && [job.requested_at, job.source_cutoff_at].some(value => value && new Date(value).getTime() > cutoff)) return await stop('newer_review_request_retained');
  const latest = (await db.query('SELECT * FROM public.contact_profile_snapshots WHERE contact_id=$1 ORDER BY generation DESC LIMIT 1', [contact.id])).rows[0];
  if (latest && !latest.model.startsWith('local-evidence-')) return await stop('existing_review_retained');
  if (latest && new Date(latest.source_cutoff_at).getTime() > cutoff) return await stop('newer_profile_retained');
  if (latest?.model === artifact.engine && latest.payload?.source_sha256 === artifact.source_sha256) return await stop('already_published');
  const prior = (await db.query('SELECT coalesce(max(generation),0)::int AS generation FROM public.contact_profile_messages WHERE contact_id=$1', [contact.id])).rows[0];
  const generation = Math.max(1, Number(job.requested_version), Number(job.working_version || 0) + 1, Number(latest?.generation || 0) + 1, Number(prior.generation) + 1);
  for (let offset = 0; offset < artifact.messages.length; offset += 500) {
   await db.query(`INSERT INTO public.contact_profile_messages(contact_id,page_id,generation,message_id,sent_at,sender,text,attachment_count,image_count)
    SELECT $1,$2,$3,m.id,m.at,m.sender,m.text,m.attachments,coalesce(m.images,0)
    FROM jsonb_to_recordset($4::jsonb) AS m(id text,at timestamptz,sender text,text text,attachments integer,images integer)`,
    [contact.id, contact.page_id, generation, JSON.stringify(artifact.messages.slice(offset, offset + 500))]);
  }
  const payload = { ...artifact.payload, source_sha256: artifact.source_sha256, preparation_engine: artifact.engine };
  await db.query(`INSERT INTO public.contact_profile_snapshots(contact_id,page_id,generation,source_cutoff_at,message_count,model,payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
   [contact.id, contact.page_id, generation, artifact.source_cutoff_at, artifact.messages.length, artifact.engine, JSON.stringify(payload)]);
  await db.query(`UPDATE public.contact_profile_jobs SET status='ready',requested_version=$2,working_version=$2,claim_token=NULL,lease_until=NULL,
   source_cutoff_at=$3,scan_cursor=NULL,scan_started=true,history_complete=true,message_count=$4,analyzed_count=$4,
   partial_analysis='[]'::jsonb,error_message=NULL,attempt_count=0,updated_at=clock_timestamp() WHERE contact_id=$1`,
   [contact.id, generation, artifact.source_cutoff_at, artifact.messages.length]);
  // Preflight creates the journal inside this transaction, so rollback also
  // removes a new journal rather than leaving schema changes behind.
  await db.query(backlogPublicationJournalSql);
  await db.query(`INSERT INTO app_private.contact_backlog_publications(contact_id,page_id,psid,engine,source_sha256,generation,source_cutoff_at)
   VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
   [contact.id, contact.page_id, artifact.psid, artifact.engine, artifact.source_sha256, generation, artifact.source_cutoff_at]);
  await db.query(apply ? 'COMMIT' : 'ROLLBACK');
  return { status: apply ? 'published' : 'preflight_passed', generation, message_count: artifact.messages.length };
 } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
}
