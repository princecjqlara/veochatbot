BEGIN;

ALTER TABLE public.chatbot_configs
    ADD COLUMN IF NOT EXISTS continuation_review_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS continuation_review_hour integer NOT NULL DEFAULT 20 CHECK (continuation_review_hour BETWEEN 0 AND 23),
    ADD COLUMN IF NOT EXISTS continuation_enabled_at timestamptz;
ALTER TABLE public.chatbot_contact_states
    ADD COLUMN IF NOT EXISTS detail_collection_target integer CHECK (detail_collection_target BETWEEN 1 AND 20),
    ADD COLUMN IF NOT EXISTS collection_round integer NOT NULL DEFAULT 0 CHECK (collection_round BETWEEN 0 AND 20);

CREATE FUNCTION public.set_chatbot_continuation_activation() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
    IF NOT NEW.continuation_review_enabled THEN NEW.continuation_enabled_at=NULL;
    ELSIF TG_OP='INSERT' THEN NEW.continuation_enabled_at=now();
    ELSIF NOT OLD.continuation_review_enabled OR (NEW.enabled AND NOT OLD.enabled) THEN NEW.continuation_enabled_at=now();
    ELSE NEW.continuation_enabled_at=OLD.continuation_enabled_at;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER chatbot_continuation_activation BEFORE INSERT OR UPDATE ON public.chatbot_configs
    FOR EACH ROW EXECUTE FUNCTION public.set_chatbot_continuation_activation();

CREATE TABLE public.chatbot_continuation_reviews (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    state_id uuid NOT NULL REFERENCES public.chatbot_contact_states(id) ON DELETE CASCADE,
    page_id uuid NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    collection_round integer NOT NULL,
    completed_at timestamptz NOT NULL,
    due_at timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','resumed','kept_stopped','skipped','failed')),
    attempt_count integer NOT NULL DEFAULT 0,
    claimed_at timestamptz,
    analysis jsonb,
    error_message text,
    reviewed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (state_id, collection_round)
);
CREATE INDEX ON public.chatbot_continuation_reviews(due_at) WHERE status='pending';
ALTER TABLE public.chatbot_continuation_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chatbot_continuation_reviews FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.chatbot_continuation_reviews TO service_role;

CREATE FUNCTION public.claim_chatbot_continuation_reviews(p_limit integer DEFAULT 2, p_now timestamptz DEFAULT now())
RETURNS SETOF public.chatbot_continuation_reviews
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
    INSERT INTO chatbot_continuation_reviews(state_id,page_id,contact_id,collection_round,completed_at,due_at)
    SELECT s.id,s.page_id,s.contact_id,s.collection_round,s.stopped_at,
        GREATEST(s.stopped_at + interval '1 minute', LEAST(
            ((date_trunc('day',s.stopped_at AT TIME ZONE 'Asia/Manila') + make_interval(hours=>cfg.continuation_review_hour)
                + CASE WHEN extract(hour FROM s.stopped_at AT TIME ZONE 'Asia/Manila') >= cfg.continuation_review_hour
                    THEN interval '1 day' ELSE interval '0 day' END) AT TIME ZONE 'Asia/Manila'),
            c.last_inbound_at + interval '23 hours'))
    FROM chatbot_contact_states s
    JOIN chatbot_configs cfg ON cfg.page_id=s.page_id
    JOIN contacts c ON c.id=s.contact_id AND c.page_id=s.page_id
    WHERE cfg.enabled AND cfg.follow_up_enabled AND cfg.continuation_review_enabled
      AND cfg.continuation_enabled_at IS NOT NULL AND s.stopped_at>=cfg.continuation_enabled_at
      AND s.status='stopped' AND s.stop_reason='details_collected' AND s.collection_round<20
      AND c.pipeline_stage='qualified' AND c.pipeline_stage_source='chatbot'
      AND c.last_inbound_at IS NOT NULL
      AND (NOT cfg.trial_mode_enabled OR cfg.trial_contact_id=c.id)
    ON CONFLICT(state_id,collection_round) DO NOTHING;

    UPDATE chatbot_continuation_reviews SET status=CASE WHEN attempt_count>=3 THEN 'failed' ELSE 'pending' END,
        claimed_at=NULL,error_message='Review lease expired'
    WHERE status='processing' AND claimed_at<p_now-interval '10 minutes';
    RETURN QUERY WITH due AS (
        SELECT id FROM chatbot_continuation_reviews WHERE status='pending' AND due_at<=p_now
        ORDER BY due_at,id FOR UPDATE SKIP LOCKED LIMIT LEAST(5,GREATEST(1,p_limit))
    ) UPDATE chatbot_continuation_reviews r SET status='processing',claimed_at=p_now,attempt_count=attempt_count+1
      FROM due WHERE r.id=due.id RETURNING r.*;
END;
$$;

CREATE FUNCTION public.resume_chatbot_continuation_review(
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
    IF cfg.page_id IS NULL OR s.id IS NULL OR c.id IS NULL OR NOT cfg.enabled OR NOT cfg.follow_up_enabled OR NOT cfg.continuation_review_enabled
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
        ON CONFLICT(contact_id,anchor_inbound_at,schedule_type,sequence_index) DO NOTHING;
    END IF;
    UPDATE chatbot_continuation_reviews SET status='resumed',analysis=p_analysis,reviewed_at=p_now,claimed_at=NULL
      WHERE id=r.id;
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_chatbot_continuation_reviews(integer,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.resume_chatbot_continuation_review(uuid,integer,timestamptz,timestamptz,timestamptz,integer,jsonb,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_chatbot_continuation_reviews(integer,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.resume_chatbot_continuation_review(uuid,integer,timestamptz,timestamptz,timestamptz,integer,jsonb,timestamptz) TO service_role;

INSERT INTO app_private.schema_migrations(version,description) VALUES('20261015_001','AI review and three-detail continuation for bot-completed intake')
ON CONFLICT(version) DO UPDATE SET description=EXCLUDED.description;
NOTIFY pgrst,'reload schema';
COMMIT;
