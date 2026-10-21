BEGIN;
-- A temporary staff pause may resume only without a paid/free-output agreement.
-- Explicit lead outcomes, holds, inbound windows, Page switches and CAS stay authoritative.
CREATE OR REPLACE FUNCTION public.resume_chatbot_nightly_review(
    p_review_id uuid,p_attempt integer,p_state_updated_at timestamptz,p_pipeline_updated_at timestamptz,
    p_last_inbound_at timestamptz,p_config_updated_at timestamptz,p_automation_epoch integer,
    p_last_human_activity_at timestamptz,p_collected_details jsonb,p_missing_details jsonb,
    p_request_type text,p_has_clear_request boolean,p_request_evidence text,p_analysis jsonb,p_now timestamptz DEFAULT now()
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r chatbot_continuation_reviews%ROWTYPE; s chatbot_contact_states%ROWTYPE;
    c contacts%ROWTYPE; cfg chatbot_configs%ROWTYPE; next_epoch integer; due timestamptz; delay_value integer;
    slot integer; day_value integer; best_hour integer; expected_missing jsonb;
BEGIN
    SELECT * INTO r FROM chatbot_continuation_reviews WHERE id=p_review_id FOR UPDATE;
    IF NOT FOUND OR r.review_kind<>'nightly_handoff' OR r.status<>'processing' OR r.attempt_count<>p_attempt OR r.due_at>p_now THEN RETURN false; END IF;
    SELECT * INTO s FROM chatbot_contact_states WHERE id=r.state_id FOR UPDATE;
    SELECT * INTO c FROM contacts WHERE id=r.contact_id AND page_id=r.page_id FOR UPDATE;
    SELECT * INTO cfg FROM chatbot_configs WHERE page_id=r.page_id FOR SHARE;
    IF cfg.page_id IS NULL OR s.id IS NULL OR c.id IS NULL OR NOT cfg.commercial_video_intake_enabled
        OR NOT cfg.enabled OR NOT cfg.follow_up_enabled OR NOT cfg.continuation_review_enabled
        OR cfg.policy_revision IS DISTINCT FROM r.policy_revision OR cfg.updated_at IS DISTINCT FROM p_config_updated_at
        OR cfg.continuation_enabled_at IS NULL OR COALESCE(s.last_human_activity_at,s.stopped_at)<cfg.continuation_enabled_at
        OR (cfg.trial_mode_enabled AND cfg.trial_contact_id IS DISTINCT FROM c.id)
        OR s.status<>'stopped' OR s.stop_reason<>'manual' OR s.pause_kind IS DISTINCT FROM 'human_takeover'
        OR s.automation_epoch IS DISTINCT FROM p_automation_epoch OR s.automation_epoch IS DISTINCT FROM r.automation_epoch
        OR s.updated_at IS DISTINCT FROM p_state_updated_at OR s.last_human_activity_at IS DISTINCT FROM p_last_human_activity_at
        OR c.pipeline_stage IN ('converted','not_qualified','order_created','opted_out')
        OR (c.pipeline_stage='qualified' AND c.pipeline_stage_source IN ('manual','messenger'))
        OR c.pipeline_stage_updated_at IS DISTINCT FROM p_pipeline_updated_at OR c.last_inbound_at IS DISTINCT FROM p_last_inbound_at
        OR COALESCE(p_analysis->>'history_verified','false')<>'true'
        OR jsonb_typeof(p_collected_details) IS DISTINCT FROM 'object' OR p_has_clear_request IS NULL
        OR (p_has_clear_request AND (p_request_type NOT IN ('commercial_video','free_concept','free_script')
            OR p_request_type IS NULL OR NULLIF(btrim(p_request_evidence),'') IS NULL)) THEN RETURN false; END IF;
    expected_missing=chatbot_commercial_missing_details(p_collected_details);
    IF expected_missing IS DISTINCT FROM p_missing_details OR (p_has_clear_request OR s.has_clear_request) THEN RETURN false; END IF;

    next_epoch=s.automation_epoch+1;
    UPDATE chatbot_contact_states SET status='active',stop_reason=NULL,stopped_at=NULL,pause_kind=NULL,
        collected_details=p_collected_details,missing_details=expected_missing,request_type=p_request_type,
        has_clear_request=p_has_clear_request,request_evidence=p_request_evidence,form_version=1,
        detail_collection_target=NULL,automation_resumed_at=p_now,automation_epoch=next_epoch,policy_revision=cfg.policy_revision,updated_at=p_now
        WHERE id=s.id;
    -- Release ordinary ownership, while durable staff outcomes are rejected above.
    UPDATE contacts SET pipeline_stage=CASE WHEN jsonb_array_length(expected_missing)>0 THEN 'collecting_details' ELSE 'engaged' END,
        pipeline_stage_source='chatbot',pipeline_stage_updated_at=p_now WHERE id=c.id AND page_id=c.page_id;
    UPDATE chatbot_follow_up_jobs SET status='cancelled',cancelled_at=p_now,claimed_at=NULL,error_message='Replaced by nightly continuation'
        WHERE page_id=r.page_id AND contact_id=r.contact_id AND status IN ('pending','processing','ready_manual');
    -- Preserve the actual inbound permission anchor; never replay elapsed slots.
    IF c.last_inbound_at>p_now-interval '23 hours 59 minutes' AND c.last_inbound_at<=p_now AND s.window_expires_at>p_now THEN
        INSERT INTO chatbot_follow_up_jobs(page_id,contact_id,anchor_inbound_at,schedule_type,sequence_index,due_at,message_text,purpose,automation_epoch,policy_revision)
        VALUES(r.page_id,r.contact_id,c.last_inbound_at,'response',0,p_now,'AI-generated from reviewed conversation at send time','nightly_continuation',next_epoch,cfg.policy_revision)
        ON CONFLICT(contact_id,anchor_inbound_at,schedule_type,sequence_index,automation_epoch,purpose) DO NOTHING;
    END IF;
    IF c.last_inbound_at IS NOT NULL AND c.last_inbound_at<=p_now AND s.window_expires_at>p_now THEN
        FOR delay_value,slot IN SELECT value::integer,(ordinality-1)::integer FROM jsonb_array_elements_text(cfg.follow_up_quick_delays_minutes) WITH ORDINALITY LOOP
            due=c.last_inbound_at+make_interval(mins=>delay_value);
            IF delay_value BETWEEN 1 AND 1439 AND due>p_now+interval '1 minute' AND due<s.window_expires_at THEN
                INSERT INTO chatbot_follow_up_jobs(page_id,contact_id,anchor_inbound_at,schedule_type,sequence_index,due_at,message_text,purpose,automation_epoch,policy_revision)
                VALUES(r.page_id,r.contact_id,c.last_inbound_at,'response',slot,due,'AI-generated from conversation at send time','scheduled',next_epoch,cfg.policy_revision)
                ON CONFLICT(contact_id,anchor_inbound_at,schedule_type,sequence_index,automation_epoch,purpose) DO NOTHING;
            END IF;
        END LOOP;
        best_hour=CASE WHEN c.best_contact_hour BETWEEN 0 AND 23 THEN c.best_contact_hour ELSE 12 END;
        FOR day_value,slot IN SELECT value::integer,(ordinality-1)::integer FROM jsonb_array_elements_text(cfg.follow_up_best_time_days) WITH ORDINALITY LOOP
            due=(date_trunc('day',c.last_inbound_at AT TIME ZONE 'Asia/Manila')+make_interval(days=>day_value-1,hours=>best_hour)) AT TIME ZONE 'Asia/Manila';
            IF day_value BETWEEN 2 AND 7 AND due>p_now+interval '1 minute' AND due<c.last_inbound_at+interval '7 days'-interval '1 minute' AND due<s.window_expires_at THEN
                INSERT INTO chatbot_follow_up_jobs(page_id,contact_id,anchor_inbound_at,schedule_type,sequence_index,due_at,message_text,purpose,automation_epoch,policy_revision)
                VALUES(r.page_id,r.contact_id,c.last_inbound_at,'human_agent',slot,due,'AI-generated from conversation at send time','scheduled',next_epoch,cfg.policy_revision)
                ON CONFLICT(contact_id,anchor_inbound_at,schedule_type,sequence_index,automation_epoch,purpose) DO NOTHING;
            END IF;
        END LOOP;
    END IF;
    UPDATE chatbot_continuation_reviews SET status='resumed',analysis=p_analysis,reviewed_at=p_now,claimed_at=NULL WHERE id=r.id;
    RETURN true;
END $$;

-- Keep the generic continuation RPC compatible with the epoch-aware job key.

INSERT INTO app_private.schema_migrations(version,description) VALUES('20261021_001','Keep accepted paid/free requests stopped at nightly review') ON CONFLICT(version) DO NOTHING;
COMMIT;
