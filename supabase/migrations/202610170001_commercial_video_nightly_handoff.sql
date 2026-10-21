-- Additive, disabled-by-default commercial-video intake and reviewed staff handoff.
BEGIN;

ALTER TABLE public.chatbot_configs
    ADD COLUMN IF NOT EXISTS commercial_video_intake_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS continuation_review_minute integer NOT NULL DEFAULT 0 CHECK (continuation_review_minute BETWEEN 0 AND 59),
    ADD COLUMN IF NOT EXISTS policy_revision integer NOT NULL DEFAULT 1 CHECK (policy_revision > 0);
ALTER TABLE public.chatbot_contact_states
    ADD COLUMN IF NOT EXISTS pause_kind text CHECK (pause_kind IN ('human_takeover','explicit_hold','ready_for_team')),
    ADD COLUMN IF NOT EXISTS last_human_activity_at timestamptz,
    ADD COLUMN IF NOT EXISTS automation_resumed_at timestamptz,
    ADD COLUMN IF NOT EXISTS automation_epoch integer NOT NULL DEFAULT 0 CHECK (automation_epoch >= 0),
    ADD COLUMN IF NOT EXISTS request_type text CHECK (request_type IN ('commercial_video','free_concept','free_script')),
    ADD COLUMN IF NOT EXISTS has_clear_request boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS request_evidence text,
    ADD COLUMN IF NOT EXISTS form_version integer,
    ADD COLUMN IF NOT EXISTS policy_revision integer NOT NULL DEFAULT 1;
ALTER TABLE public.chatbot_contact_states
    DROP CONSTRAINT IF EXISTS chatbot_state_pause_requires_stop,
    DROP CONSTRAINT IF EXISTS chatbot_state_clear_request_evidence,
    ADD CONSTRAINT chatbot_state_pause_requires_stop CHECK (pause_kind IS NULL OR status='stopped'),
    ADD CONSTRAINT chatbot_state_clear_request_evidence CHECK (NOT has_clear_request OR
        (request_type IS NOT NULL AND NULLIF(btrim(request_evidence),'') IS NOT NULL));

ALTER TABLE public.chatbot_follow_up_jobs
    ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'scheduled' CHECK (purpose IN ('scheduled','nightly_continuation')),
    ADD COLUMN IF NOT EXISTS automation_epoch integer NOT NULL DEFAULT 0 CHECK (automation_epoch >= 0),
    ADD COLUMN IF NOT EXISTS policy_revision integer NOT NULL DEFAULT 1;
-- Retain the old four-column constraint during deployment so the previous
-- application can still schedule reminders. Activation removes it transactionally
-- after the epoch-aware application is live, immediately before enabling policy.
CREATE UNIQUE INDEX IF NOT EXISTS chatbot_follow_up_jobs_epoch_slot_key ON public.chatbot_follow_up_jobs
    (contact_id,anchor_inbound_at,schedule_type,sequence_index,automation_epoch,purpose);

ALTER TABLE public.chatbot_continuation_reviews
    ADD COLUMN IF NOT EXISTS review_kind text NOT NULL DEFAULT 'legacy_intake' CHECK (review_kind IN ('legacy_intake','nightly_handoff')),
    ADD COLUMN IF NOT EXISTS handoff_version integer,
    ADD COLUMN IF NOT EXISTS review_date_ph date,
    ADD COLUMN IF NOT EXISTS automation_epoch integer,
    ADD COLUMN IF NOT EXISTS policy_revision integer;
ALTER TABLE public.chatbot_continuation_reviews DROP CONSTRAINT IF EXISTS chatbot_continuation_reviews_state_id_collection_round_key;
CREATE UNIQUE INDEX IF NOT EXISTS chatbot_continuation_legacy_round_key ON public.chatbot_continuation_reviews(state_id,collection_round)
    WHERE review_kind='legacy_intake';
DROP INDEX IF EXISTS public.chatbot_continuation_nightly_episode_key;
CREATE UNIQUE INDEX chatbot_continuation_nightly_episode_key ON public.chatbot_continuation_reviews(state_id,automation_epoch,review_date_ph,policy_revision)
    WHERE review_kind='nightly_handoff';
CREATE INDEX IF NOT EXISTS chatbot_nightly_takeovers ON public.chatbot_contact_states(page_id,last_human_activity_at)
    WHERE status='stopped' AND pause_kind='human_takeover';

CREATE OR REPLACE FUNCTION public.enforce_chatbot_commercial_policy() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
    IF NEW.commercial_video_intake_enabled THEN
        NEW.continuation_review_hour=23;
        NEW.continuation_review_minute=59;
    END IF;
    IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'updated_at'-'policy_revision'-'continuation_enabled_at') IS DISTINCT FROM
            (to_jsonb(OLD)-'updated_at'-'policy_revision'-'continuation_enabled_at') THEN
        NEW.policy_revision=OLD.policy_revision+1;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS chatbot_commercial_policy ON public.chatbot_configs;
CREATE TRIGGER chatbot_commercial_policy BEFORE INSERT OR UPDATE ON public.chatbot_configs
    FOR EACH ROW EXECUTE FUNCTION public.enforce_chatbot_commercial_policy();

-- The state row is the ownership gate. Preserve durable stops against stale workers,
-- and invalidate every old outbound job when a newer person takes over.
CREATE OR REPLACE FUNCTION public.enforce_chatbot_ownership() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE newer_human boolean := false; durable_old boolean := false; durable_new boolean := false;
BEGIN
    IF TG_OP='UPDATE' THEN
        durable_old := COALESCE(OLD.status='stopped' AND (OLD.pause_kind='explicit_hold' OR OLD.stop_reason IN
            ('opt_out','refusal','not_qualified','converted','order_created')),false);
        durable_new := COALESCE(NEW.status='stopped' AND (NEW.pause_kind='explicit_hold' OR NEW.stop_reason IN
            ('opt_out','refusal','qualified','not_qualified','converted','order_created')),false);
        IF (durable_old AND NOT durable_new) OR (OLD.stop_reason='opt_out' AND NEW.stop_reason IS DISTINCT FROM 'opt_out') THEN
            NEW.status=OLD.status; NEW.stop_reason=OLD.stop_reason; NEW.stopped_at=OLD.stopped_at; NEW.pause_kind=OLD.pause_kind;
        END IF;
        IF NEW.last_human_activity_at IS NOT NULL AND
                (OLD.last_human_activity_at IS NULL OR NEW.last_human_activity_at>OLD.last_human_activity_at) AND
                (OLD.automation_resumed_at IS NULL OR NEW.last_human_activity_at>OLD.automation_resumed_at) THEN
            newer_human := true;
        END IF;
        NEW.last_human_activity_at=GREATEST(OLD.last_human_activity_at,NEW.last_human_activity_at);
        -- A delayed echo predating the acknowledged resume is not a new takeover.
        IF NEW.pause_kind='human_takeover' AND OLD.status='active' AND NOT newer_human
                AND NEW.last_human_activity_at IS NOT NULL AND OLD.automation_resumed_at IS NOT NULL
                AND NEW.last_human_activity_at<=OLD.automation_resumed_at THEN
            NEW.status=OLD.status; NEW.stop_reason=OLD.stop_reason; NEW.stopped_at=OLD.stopped_at; NEW.pause_kind=OLD.pause_kind;
        END IF;
        IF newer_human AND NOT durable_old AND NOT durable_new THEN
            NEW.status='stopped'; NEW.stop_reason='manual'; NEW.pause_kind='human_takeover';
            NEW.stopped_at=NEW.last_human_activity_at;
        END IF;
        IF newer_human OR (NEW.status='stopped' AND (OLD.status<>'stopped' OR NEW.pause_kind IS DISTINCT FROM OLD.pause_kind)) THEN
            NEW.automation_epoch=GREATEST(NEW.automation_epoch,OLD.automation_epoch+1);
        ELSE
            NEW.automation_epoch=GREATEST(NEW.automation_epoch,OLD.automation_epoch);
        END IF;
    END IF;
    IF NEW.status='active' THEN NEW.pause_kind=NULL; END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS chatbot_ownership ON public.chatbot_contact_states;
CREATE TRIGGER chatbot_ownership BEFORE INSERT OR UPDATE ON public.chatbot_contact_states
    FOR EACH ROW EXECUTE FUNCTION public.enforce_chatbot_ownership();
CREATE OR REPLACE FUNCTION public.cancel_chatbot_jobs_on_pause() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
    IF NEW.status='stopped' THEN
        UPDATE chatbot_follow_up_jobs SET status='cancelled',cancelled_at=clock_timestamp(),claimed_at=NULL,
            error_message='Chatbot paused; previous automation invalidated'
        WHERE page_id=NEW.page_id AND contact_id=NEW.contact_id AND status IN ('pending','processing','ready_manual');
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS chatbot_cancel_jobs_after_pause ON public.chatbot_contact_states;
CREATE TRIGGER chatbot_cancel_jobs_after_pause AFTER INSERT OR UPDATE ON public.chatbot_contact_states
    FOR EACH ROW EXECUTE FUNCTION public.cancel_chatbot_jobs_on_pause();

CREATE OR REPLACE FUNCTION public.chatbot_nightly_due_at(p_activity timestamptz) RETURNS timestamptz
LANGUAGE sql IMMUTABLE STRICT SET search_path=public,pg_temp AS $$
    SELECT (date_trunc('day',p_activity AT TIME ZONE 'Asia/Manila')+interval '23 hours 59 minutes'+
        CASE WHEN (p_activity AT TIME ZONE 'Asia/Manila')::time>=time '23:59' THEN interval '1 day' ELSE interval '0 day' END)
        AT TIME ZONE 'Asia/Manila'
$$;

CREATE OR REPLACE FUNCTION public.claim_chatbot_continuation_reviews(p_limit integer DEFAULT 2,p_now timestamptz DEFAULT now())
RETURNS SETOF public.chatbot_continuation_reviews LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
    INSERT INTO chatbot_continuation_reviews(state_id,page_id,contact_id,collection_round,completed_at,due_at)
    SELECT s.id,s.page_id,s.contact_id,s.collection_round,s.stopped_at,
        GREATEST(s.stopped_at+interval '1 minute',LEAST(
            ((date_trunc('day',s.stopped_at AT TIME ZONE 'Asia/Manila')+make_interval(hours=>cfg.continuation_review_hour)
                +CASE WHEN extract(hour FROM s.stopped_at AT TIME ZONE 'Asia/Manila')>=cfg.continuation_review_hour
                    THEN interval '1 day' ELSE interval '0 day' END) AT TIME ZONE 'Asia/Manila'),c.last_inbound_at+interval '23 hours'))
    FROM chatbot_contact_states s JOIN chatbot_configs cfg ON cfg.page_id=s.page_id
    JOIN contacts c ON c.id=s.contact_id AND c.page_id=s.page_id
    WHERE NOT cfg.commercial_video_intake_enabled AND cfg.enabled AND cfg.follow_up_enabled AND cfg.continuation_review_enabled
        AND cfg.continuation_enabled_at IS NOT NULL AND s.stopped_at>=cfg.continuation_enabled_at
        AND s.status='stopped' AND s.stop_reason='details_collected' AND s.collection_round<20
        AND c.pipeline_stage='qualified' AND c.pipeline_stage_source='chatbot' AND c.last_inbound_at IS NOT NULL
        AND (NOT cfg.trial_mode_enabled OR cfg.trial_contact_id=c.id)
    ON CONFLICT(state_id,collection_round) WHERE review_kind='legacy_intake' DO NOTHING;

    INSERT INTO chatbot_continuation_reviews(state_id,page_id,contact_id,collection_round,completed_at,due_at,
        review_kind,handoff_version,review_date_ph,automation_epoch,policy_revision)
    SELECT s.id,s.page_id,s.contact_id,s.collection_round,COALESCE(s.last_human_activity_at,s.stopped_at),
        chatbot_nightly_due_at(COALESCE(s.last_human_activity_at,s.stopped_at)),'nightly_handoff',s.automation_epoch,
        (chatbot_nightly_due_at(COALESCE(s.last_human_activity_at,s.stopped_at)) AT TIME ZONE 'Asia/Manila')::date,
        s.automation_epoch,cfg.policy_revision
    FROM chatbot_contact_states s JOIN chatbot_configs cfg ON cfg.page_id=s.page_id
    JOIN contacts c ON c.id=s.contact_id AND c.page_id=s.page_id
    WHERE cfg.commercial_video_intake_enabled AND cfg.enabled AND cfg.follow_up_enabled AND cfg.continuation_review_enabled
        AND cfg.continuation_enabled_at IS NOT NULL AND COALESCE(s.last_human_activity_at,s.stopped_at)>=cfg.continuation_enabled_at
        AND s.status='stopped' AND s.pause_kind='human_takeover' AND s.stop_reason='manual'
        AND c.pipeline_stage NOT IN ('converted','not_qualified','order_created','opted_out')
        AND (NOT cfg.trial_mode_enabled OR cfg.trial_contact_id=c.id)
    ON CONFLICT(state_id,automation_epoch,review_date_ph,policy_revision) WHERE review_kind='nightly_handoff' DO NOTHING;

    UPDATE chatbot_continuation_reviews SET status=CASE WHEN attempt_count>=3 THEN 'failed' ELSE 'pending' END,
        claimed_at=NULL,error_message='Review lease expired' WHERE status='processing' AND claimed_at<p_now-interval '10 minutes';
    RETURN QUERY WITH due AS (
        SELECT id FROM chatbot_continuation_reviews WHERE status='pending' AND due_at<=p_now
        ORDER BY due_at,id FOR UPDATE SKIP LOCKED LIMIT LEAST(100,GREATEST(1,p_limit))
    ) UPDATE chatbot_continuation_reviews r SET status='processing',claimed_at=p_now,attempt_count=attempt_count+1
        FROM due WHERE r.id=due.id RETURNING r.*;
END $$;

CREATE OR REPLACE FUNCTION public.chatbot_commercial_missing_details(p_details jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
    SELECT COALESCE(jsonb_agg(label ORDER BY ordinal),'[]'::jsonb) FROM
        (VALUES ('Business Name',1),('Business Location',2),('Goal ng video',3),('Contact Number',4)) f(label,ordinal)
    WHERE jsonb_typeof(p_details->label) IS DISTINCT FROM 'string' OR NULLIF(btrim(p_details->>label),'') IS NULL
        OR btrim(p_details->>label) ~* '^(unknown|not (provided|specified|stated|yet provided|yet specified)|n/?a|none|null|undefined|pending|tbd|to be (confirmed|determined)|not sure|unsure|hindi pa alam|wala( pa)?|[-?]+)[.!?[:space:]]*$'
        OR (label='Contact Number' AND (length(regexp_replace(p_details->>label,'[^0-9]','','g')) NOT BETWEEN 7 AND 15
            OR btrim(p_details->>label) !~ '^[+0-9[:space:]().-]+$'
            OR regexp_replace(p_details->>label,'[^0-9]','','g') ~ '^([0-9])\1+$'))
$$;

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
        OR c.pipeline_stage_updated_at IS DISTINCT FROM p_pipeline_updated_at OR c.last_inbound_at IS DISTINCT FROM p_last_inbound_at
        OR COALESCE(p_analysis->>'history_verified','false')<>'true'
        OR jsonb_typeof(p_collected_details) IS DISTINCT FROM 'object' OR p_has_clear_request IS NULL
        OR (p_has_clear_request AND (p_request_type NOT IN ('commercial_video','free_concept','free_script')
            OR p_request_type IS NULL OR NULLIF(btrim(p_request_evidence),'') IS NULL)) THEN RETURN false; END IF;
    expected_missing=chatbot_commercial_missing_details(p_collected_details);
    IF expected_missing IS DISTINCT FROM p_missing_details OR (jsonb_array_length(expected_missing)=0 AND p_has_clear_request) THEN RETURN false; END IF;

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
CREATE OR REPLACE FUNCTION public.resume_chatbot_continuation_review(
    p_review_id uuid,p_attempt integer,p_state_updated_at timestamptz,p_pipeline_updated_at timestamptz,
    p_last_inbound_at timestamptz,p_target integer,p_analysis jsonb,p_now timestamptz DEFAULT now()
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
    r chatbot_continuation_reviews%ROWTYPE;
    s chatbot_contact_states%ROWTYPE;
    c contacts%ROWTYPE;
    cfg chatbot_configs%ROWTYPE;
    collected integer;
    total integer;
BEGIN
    SELECT * INTO r FROM chatbot_continuation_reviews WHERE id=p_review_id FOR UPDATE;
    IF NOT FOUND OR r.status<>'processing' OR r.attempt_count<>p_attempt THEN RETURN false; END IF;
    SELECT * INTO s FROM chatbot_contact_states WHERE id=r.state_id FOR UPDATE;
    SELECT * INTO c FROM contacts WHERE id=r.contact_id AND page_id=r.page_id FOR UPDATE;
    SELECT * INTO cfg FROM chatbot_configs WHERE page_id=r.page_id FOR SHARE;
    IF cfg.commercial_video_intake_enabled OR cfg.page_id IS NULL OR s.id IS NULL OR c.id IS NULL OR NOT cfg.enabled OR NOT cfg.follow_up_enabled OR NOT cfg.continuation_review_enabled
      OR cfg.continuation_enabled_at IS NULL OR s.stopped_at<cfg.continuation_enabled_at
      OR (cfg.trial_mode_enabled AND cfg.trial_contact_id IS DISTINCT FROM c.id)
      OR s.status<>'stopped' OR s.stop_reason<>'details_collected' OR s.collection_round<>r.collection_round
      OR s.updated_at IS DISTINCT FROM p_state_updated_at
      OR c.pipeline_stage<>'qualified' OR c.pipeline_stage_source<>'chatbot'
      OR c.pipeline_stage_updated_at IS DISTINCT FROM p_pipeline_updated_at
      OR c.last_inbound_at IS DISTINCT FROM p_last_inbound_at
      OR c.last_inbound_at<p_now-interval '7 days'
      OR p_analysis->>'purchase_status'<>'undecided'
      OR COALESCE((p_analysis->>'confidence')::numeric,0)<0.8 THEN RETURN false; END IF;

    SELECT count(*) INTO total FROM (SELECT DISTINCT lower(trim(value)) FROM jsonb_array_elements_text(cfg.details_to_collect)) d;
    SELECT count(*) INTO collected FROM (SELECT DISTINCT lower(trim(d.value)) AS field
        FROM jsonb_array_elements_text(cfg.details_to_collect) d
        JOIN jsonb_each(s.collected_details) e ON lower(trim(e.key))=lower(trim(d.value))
        WHERE jsonb_typeof(e.value)='string' AND trim(e.value #>> '{}')<>''
          AND trim(e.value #>> '{}') !~* '^(unknown|not (provided|specified|stated|yet provided|yet specified)|n/?a|null|undefined|pending|tbd|to be (confirmed|determined)|not sure|unsure|hindi pa alam)[.!?[:space:]]*$') d;
    IF p_target IS DISTINCT FROM LEAST(total,collected+3) OR p_target<=collected THEN RETURN false; END IF;

    UPDATE contacts SET pipeline_stage='collecting_details',pipeline_stage_source='chatbot',pipeline_stage_updated_at=p_now
      WHERE id=c.id AND page_id=c.page_id;
    UPDATE chatbot_contact_states SET status='active',stop_reason=NULL,stopped_at=NULL,
      detail_collection_target=p_target,collection_round=collection_round+1,updated_at=p_now
      WHERE id=s.id;
    UPDATE chatbot_follow_up_jobs SET status='cancelled',cancelled_at=p_now,claimed_at=NULL,
      error_message='Replaced by reviewed intake continuation'
      WHERE page_id=r.page_id AND contact_id=r.contact_id AND status IN ('pending','processing','ready_manual');
    -- Never extend Messenger permission with a Page reply or the review itself.
    IF c.last_inbound_at>p_now-interval '23 hours 59 minutes' AND c.last_inbound_at<=p_now THEN
        INSERT INTO chatbot_follow_up_jobs(page_id,contact_id,anchor_inbound_at,schedule_type,sequence_index,due_at,message_text)
        VALUES(r.page_id,r.contact_id,c.last_inbound_at,'response',1000+s.collection_round+1,p_now,'AI-generated from reviewed conversation at send time')
        ON CONFLICT(contact_id,anchor_inbound_at,schedule_type,sequence_index,automation_epoch,purpose) DO NOTHING;
    END IF;
    UPDATE chatbot_continuation_reviews SET status='resumed',analysis=p_analysis,reviewed_at=p_now,claimed_at=NULL
      WHERE id=r.id;
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.resume_chatbot_nightly_review(uuid,integer,timestamptz,timestamptz,timestamptz,timestamptz,integer,timestamptz,jsonb,jsonb,text,boolean,text,jsonb,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.resume_chatbot_nightly_review(uuid,integer,timestamptz,timestamptz,timestamptz,timestamptz,integer,timestamptz,jsonb,jsonb,text,boolean,text,jsonb,timestamptz) TO service_role;

INSERT INTO app_private.schema_migrations(version,description) VALUES('20261017_001','Four-field intake ownership and atomic 23:59 Philippine-time continuation')
ON CONFLICT(version) DO UPDATE SET description=EXCLUDED.description;
NOTIFY pgrst,'reload schema';
COMMIT;
