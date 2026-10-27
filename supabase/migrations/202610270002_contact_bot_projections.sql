BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS chatbot_enabled BOOLEAN NOT NULL DEFAULT TRUE;
CREATE INDEX IF NOT EXISTS idx_contacts_page_bot_recent ON public.contacts(page_id,chatbot_enabled,last_interaction_at DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS public.contact_bot_permission_events(
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
 actor_id UUID NOT NULL REFERENCES users(id),enabled BOOLEAN NOT NULL,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS public.contact_conversion_cache(
 contact_id UUID PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
 page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 first_inquiry_at TIMESTAMPTZ NOT NULL,first_message_id TEXT,source_cutoff_at TIMESTAMPTZ NOT NULL,
 snapshots JSONB NOT NULL DEFAULT '[]',payment_at TIMESTAMPTZ,payment_evidence_id TEXT,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('audited_history','live_graph')),
 complete_history BOOLEAN NOT NULL DEFAULT FALSE,
 dirty_at TIMESTAMPTZ,updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CHECK(payment_at IS NULL OR payment_evidence_id IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS public.contact_conversion_prediction_issues(
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
 model_version TEXT NOT NULL,score_hour TIMESTAMPTZ NOT NULL,
 source_cutoff_at TIMESTAMPTZ NOT NULL,issued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 prediction JSONB NOT NULL,
 UNIQUE(contact_id,model_version,score_hour)
);
CREATE OR REPLACE FUNCTION public.dirty_contact_conversion_cache() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NEW.last_inbound_at IS DISTINCT FROM OLD.last_inbound_at OR NEW.pipeline_stage IS DISTINCT FROM OLD.pipeline_stage
    OR NEW.pipeline_stage_source IS DISTINCT FROM OLD.pipeline_stage_source THEN
  UPDATE contact_conversion_cache SET dirty_at=clock_timestamp() WHERE contact_id=NEW.id AND page_id=NEW.page_id;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS dirty_contact_conversion_cache ON contacts;
CREATE TRIGGER dirty_contact_conversion_cache AFTER UPDATE OF last_inbound_at,pipeline_stage,pipeline_stage_source ON contacts
FOR EACH ROW EXECUTE FUNCTION dirty_contact_conversion_cache();

CREATE OR REPLACE FUNCTION public.set_contact_bot_permission(p_page_id UUID,p_contact_id UUID,p_actor_id UUID,p_enabled BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE old_permission BOOLEAN; cancelled INTEGER:=0;
BEGIN
 IF p_enabled IS NULL OR NOT EXISTS(SELECT 1 FROM user_pages WHERE page_id=p_page_id AND user_id=p_actor_id) THEN RAISE EXCEPTION 'Page membership required'; END IF;
 SELECT chatbot_enabled INTO old_permission FROM contacts WHERE id=p_contact_id AND page_id=p_page_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Contact not found'; END IF;
 IF old_permission IS DISTINCT FROM p_enabled THEN
  UPDATE contacts SET chatbot_enabled=p_enabled,updated_at=clock_timestamp() WHERE id=p_contact_id AND page_id=p_page_id;
  -- Invalidate work already generated or claimed. Permission-on never replays it.
  UPDATE chatbot_contact_states SET automation_epoch=COALESCE(automation_epoch,0)+1,updated_at=clock_timestamp()
    WHERE contact_id=p_contact_id AND page_id=p_page_id;
  UPDATE chatbot_follow_up_jobs SET status='cancelled',cancelled_at=clock_timestamp(),claimed_at=NULL,
    error_message='Contact bot permission changed',updated_at=clock_timestamp()
    WHERE contact_id=p_contact_id AND page_id=p_page_id AND status IN ('pending','processing','ready_manual','waiting_response');
  GET DIAGNOSTICS cancelled=ROW_COUNT;
  INSERT INTO contact_bot_permission_events(page_id,contact_id,actor_id,enabled) VALUES(p_page_id,p_contact_id,p_actor_id,p_enabled);
 END IF;
 RETURN jsonb_build_object('enabled',p_enabled,'changed',old_permission IS DISTINCT FROM p_enabled,'cancelled_follow_ups',cancelled);
END $$;

CREATE OR REPLACE FUNCTION public.get_contact_controls(p_page_id UUID,p_contact_ids UUID[])
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'contact_id',c.id,'enabled',c.chatbot_enabled,'pipeline_stage',c.pipeline_stage,
  'reason',CASE WHEN NOT c.chatbot_enabled THEN 'contact_disabled'
   WHEN NOT COALESCE(b.enabled,FALSE) THEN 'page_disabled'
   WHEN b.trial_mode_enabled AND b.trial_contact_id IS DISTINCT FROM c.id THEN 'outside_page_trial'
   WHEN c.pipeline_stage IN ('converted','not_qualified','order_created','opted_out') THEN 'closed_stage'
   WHEN c.pipeline_stage_source IN ('manual','messenger') THEN 'human_handoff'
   WHEN c.pipeline_stage='qualified' AND NOT(COALESCE(b.commercial_video_intake_enabled,FALSE) AND c.pipeline_stage_source='chatbot') THEN 'closed_stage'
   WHEN s.status='stopped' THEN 'paused_'||COALESCE(s.stop_reason,'manual')
   WHEN c.last_inbound_at IS NULL OR c.last_inbound_at<now()-interval '7 days' THEN 'awaiting_new_message'
   ELSE 'allowed' END,
  'cache',CASE WHEN f.contact_id IS NOT NULL THEN to_jsonb(f) ELSE NULL END
  )),'[]'::jsonb)
 FROM contacts c LEFT JOIN chatbot_configs b ON b.page_id=c.page_id
 LEFT JOIN chatbot_contact_states s ON s.contact_id=c.id AND s.page_id=c.page_id
 LEFT JOIN contact_conversion_cache f ON f.contact_id=c.id AND f.page_id=c.page_id
 WHERE c.page_id=p_page_id AND c.id=ANY(p_contact_ids) AND cardinality(p_contact_ids)<=100;
$$;

CREATE OR REPLACE FUNCTION public.mark_contact_projection_dirty(p_page_id UUID,p_psid TEXT)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 UPDATE contact_conversion_cache SET dirty_at=clock_timestamp()
 WHERE page_id=p_page_id AND contact_id IN(SELECT id FROM contacts WHERE page_id=p_page_id AND psid=p_psid);
$$;

CREATE OR REPLACE FUNCTION public.save_contact_conversion_cache(p_page_id UUID,p_contact_id UUID,p_payload JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_cut TIMESTAMPTZ:=(p_payload->>'source_cutoff_at')::timestamptz;
 v_first TIMESTAMPTZ:=(p_payload->>'first_inquiry_at')::timestamptz;
 v_payment TIMESTAMPTZ:=(p_payload->>'payment_at')::timestamptz;
 v_row contact_conversion_cache%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM contacts WHERE id=p_contact_id AND page_id=p_page_id) THEN RAISE EXCEPTION 'Contact outside Page'; END IF;
 IF v_first IS NULL OR v_cut IS NULL OR v_first>v_cut OR v_cut>clock_timestamp()+interval '1 minute'
 OR jsonb_typeof(p_payload->'snapshots')<>'array' OR jsonb_array_length(p_payload->'snapshots')>7
 OR v_payment IS NOT NULL AND (v_payment<v_first OR v_payment>v_cut OR NULLIF(p_payload->>'payment_evidence_id','') IS NULL)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'snapshots') f WHERE (f->>'h')::numeric NOT IN(0,1,6,24,72,168,336)
   OR v_first+((f->>'h')::numeric*interval '1 hour')>v_cut) THEN RAISE EXCEPTION 'Invalid verified prediction source'; END IF;
 INSERT INTO contact_conversion_cache AS old(contact_id,page_id,first_inquiry_at,first_message_id,source_cutoff_at,snapshots,payment_at,payment_evidence_id,source_kind,complete_history,dirty_at)
 VALUES(p_contact_id,p_page_id,v_first,p_payload->>'first_message_id',v_cut,p_payload->'snapshots',v_payment,p_payload->>'payment_evidence_id','live_graph',TRUE,
   CASE WHEN (SELECT last_inbound_at FROM contacts WHERE id=p_contact_id)>v_cut THEN clock_timestamp() END)
 ON CONFLICT(contact_id) DO UPDATE SET first_inquiry_at=EXCLUDED.first_inquiry_at,first_message_id=EXCLUDED.first_message_id,source_cutoff_at=EXCLUDED.source_cutoff_at,snapshots=EXCLUDED.snapshots,
 payment_at=EXCLUDED.payment_at,payment_evidence_id=EXCLUDED.payment_evidence_id,source_kind=EXCLUDED.source_kind,complete_history=TRUE,
 dirty_at=CASE WHEN old.dirty_at>EXCLUDED.source_cutoff_at THEN old.dirty_at ELSE EXCLUDED.dirty_at END,updated_at=clock_timestamp()
 WHERE old.page_id=p_page_id AND old.source_cutoff_at<=EXCLUDED.source_cutoff_at;
 IF NULLIF(p_payload->>'first_message_id','') IS NOT NULL THEN
  INSERT INTO ad_contact_sources AS s(contact_id,page_id,first_inquiry_at,first_message_id,inquiry_basis)
  VALUES(p_contact_id,p_page_id,v_first,p_payload->>'first_message_id','verified_history')
  ON CONFLICT(contact_id) DO UPDATE SET first_inquiry_at=EXCLUDED.first_inquiry_at,first_message_id=EXCLUDED.first_message_id,inquiry_basis='verified_history',
   origin_ad_id=CASE WHEN s.first_inquiry_at IS DISTINCT FROM EXCLUDED.first_inquiry_at THEN NULL ELSE s.origin_ad_id END,
   origin_evidence_key=CASE WHEN s.first_inquiry_at IS DISTINCT FROM EXCLUDED.first_inquiry_at THEN NULL ELSE s.origin_evidence_key END,
   attribution_status=CASE WHEN s.first_inquiry_at IS DISTINCT FROM EXCLUDED.first_inquiry_at THEN 'unknown' ELSE s.attribution_status END,updated_at=clock_timestamp()
  WHERE s.first_inquiry_at IS NULL OR EXCLUDED.first_inquiry_at<s.first_inquiry_at OR s.inquiry_basis='legacy_recorded';
 END IF;
 SELECT * INTO v_row FROM contact_conversion_cache WHERE contact_id=p_contact_id AND page_id=p_page_id;
 RETURN to_jsonb(v_row);
END $$;

CREATE OR REPLACE FUNCTION public.get_ad_lead_contacts_v2(
 p_page_id UUID,p_from TIMESTAMPTZ DEFAULT NULL,p_to TIMESTAMPTZ DEFAULT now(),p_ad_id TEXT DEFAULT NULL,
 p_unknown BOOLEAN DEFAULT FALSE,p_stage TEXT DEFAULT NULL,p_bot TEXT DEFAULT 'all',p_limit INTEGER DEFAULT 25,p_offset INTEGER DEFAULT 0
) RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
WITH selected AS MATERIALIZED (
 SELECT a.*,c.chatbot_enabled FROM ad_lead_cohorts a JOIN contacts c ON c.id=a.id AND c.page_id=a.page_id
 WHERE a.page_id=p_page_id AND a.first_inquiry_at IS NOT NULL
 AND (p_from IS NULL OR a.first_inquiry_at>=p_from) AND a.first_inquiry_at<p_to
 AND (NOT p_unknown OR a.ad_id IS NULL) AND (p_ad_id IS NULL OR a.ad_id=p_ad_id)
 AND (p_stage IS NULL OR a.pipeline_stage=p_stage)
 AND (p_bot='all' OR p_bot='on' AND c.chatbot_enabled OR p_bot='off' AND NOT c.chatbot_enabled)
), limited AS (
 SELECT * FROM selected ORDER BY first_inquiry_at DESC,id LIMIT LEAST(GREATEST(p_limit,1),100) OFFSET GREATEST(p_offset,0)
)
SELECT jsonb_build_object('total',(SELECT count(*) FROM selected),'contacts',COALESCE((SELECT jsonb_agg(to_jsonb(l)) FROM limited l),'[]'::jsonb));
$$;

ALTER TABLE contact_bot_permission_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_conversion_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_conversion_prediction_issues ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON contact_bot_permission_events,contact_conversion_cache,contact_conversion_prediction_issues FROM PUBLIC,anon,authenticated;
GRANT ALL ON contact_bot_permission_events,contact_conversion_cache,contact_conversion_prediction_issues TO service_role;
GRANT USAGE,SELECT ON SEQUENCE contact_bot_permission_events_id_seq,contact_conversion_prediction_issues_id_seq TO service_role;
REVOKE ALL ON FUNCTION set_contact_bot_permission(UUID,UUID,UUID,BOOLEAN),get_contact_controls(UUID,UUID[]),mark_contact_projection_dirty(UUID,TEXT),get_ad_lead_contacts_v2(UUID,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,BOOLEAN,TEXT,TEXT,INTEGER,INTEGER) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION dirty_contact_conversion_cache() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION save_contact_conversion_cache(UUID,UUID,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION set_contact_bot_permission(UUID,UUID,UUID,BOOLEAN),get_contact_controls(UUID,UUID[]),mark_contact_projection_dirty(UUID,TEXT),get_ad_lead_contacts_v2(UUID,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,BOOLEAN,TEXT,TEXT,INTEGER,INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION save_contact_conversion_cache(UUID,UUID,JSONB) TO service_role;
INSERT INTO app_private.schema_migrations(version,description) VALUES('20261027_002','Individual bot permission, guarded delivery, and customer conversion forecast cache') ON CONFLICT DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
