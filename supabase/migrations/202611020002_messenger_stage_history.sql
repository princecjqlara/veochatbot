BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';

ALTER TABLE public.contacts
    ADD COLUMN IF NOT EXISTS messenger_stage_label TEXT,
    ADD COLUMN IF NOT EXISTS messenger_stage_event_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS messenger_stage_message_id TEXT;
ALTER TABLE public.pages ADD COLUMN IF NOT EXISTS messaging_auto_tag_lease_until TIMESTAMPTZ;

ALTER TABLE public.tags DROP CONSTRAINT IF EXISTS tags_system_key_check;
ALTER TABLE public.tags ADD CONSTRAINT tags_system_key_check CHECK (
    system_key IS NULL OR (owner_type='page' AND page_id=owner_id AND
    (system_key IN ('qualified','not_qualified','converted','order_created') OR system_key LIKE 'stage_history:%'))
);

CREATE TABLE IF NOT EXISTS public.messenger_lead_stage_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    label TEXT NOT NULL,
    stage TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    applied BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE(page_id,message_id)
);
CREATE INDEX IF NOT EXISTS idx_messenger_stage_contact_time
    ON public.messenger_lead_stage_events(contact_id,occurred_at DESC,id DESC);
ALTER TABLE public.messenger_lead_stage_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.messenger_lead_stage_events FROM anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.messenger_lead_stage_events TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.messenger_lead_stage_events_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.add_contact_stage_history_tag(p_page_id UUID,p_contact_id UUID,p_label TEXT,p_stage TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE history_tag_id UUID; label TEXT=btrim(p_label); normalized TEXT; tag_key TEXT; color TEXT;
BEGIN
    IF label IS NULL OR length(label) NOT BETWEEN 1 AND 80 OR label ~ '[\r\n]' THEN RAISE EXCEPTION 'Invalid stage label'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.contacts WHERE id=p_contact_id AND page_id=p_page_id) THEN RAISE EXCEPTION 'Contact does not belong to Page'; END IF;
    normalized=regexp_replace(lower(label),'[[:space:]-]+','_','g');
    tag_key='stage_history:' || CASE WHEN normalized IN ('new','engaged','collecting_details','qualified','not_qualified','converted','order_created','opted_out','intake','contacted','interested') THEN normalized ELSE 'custom:' || md5(lower(label)) END;
    color=CASE p_stage WHEN 'qualified' THEN '#2563eb' WHEN 'not_qualified' THEN '#dc2626' WHEN 'converted' THEN '#7c3aed' WHEN 'order_created' THEN '#f59e0b' ELSE '#64748b' END;
    INSERT INTO public.tags(name,color,owner_type,owner_id,page_id,is_default,system_key)
    VALUES('History: '||label,color,'page',p_page_id,p_page_id,FALSE,tag_key)
    ON CONFLICT(owner_id,system_key) DO UPDATE SET system_key=EXCLUDED.system_key RETURNING id INTO history_tag_id;
    INSERT INTO public.contact_tags(contact_id,tag_id) VALUES(p_contact_id,history_tag_id) ON CONFLICT(contact_id,tag_id) DO NOTHING;
    RETURN history_tag_id;
END; $$;

CREATE OR REPLACE FUNCTION public.capture_contact_stage_history_tag()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE label TEXT;
BEGIN
    IF TG_OP='INSERT' AND NEW.pipeline_stage='new' AND NEW.pipeline_stage_source='system' THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND NEW.pipeline_stage IS NOT DISTINCT FROM OLD.pipeline_stage
       AND NEW.pipeline_stage_source IS NOT DISTINCT FROM OLD.pipeline_stage_source
       AND NEW.messenger_stage_label IS NOT DISTINCT FROM OLD.messenger_stage_label THEN RETURN NEW; END IF;
    label=CASE WHEN NEW.pipeline_stage_source='messenger' AND NEW.messenger_stage_label IS NOT NULL
        THEN NEW.messenger_stage_label ELSE initcap(replace(NEW.pipeline_stage,'_',' ')) END;
    PERFORM public.add_contact_stage_history_tag(NEW.page_id,NEW.id,label,NEW.pipeline_stage);
    RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS capture_contact_stage_history_tag ON public.contacts;
CREATE TRIGGER capture_contact_stage_history_tag AFTER INSERT OR UPDATE OF pipeline_stage,pipeline_stage_source,messenger_stage_label
    ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.capture_contact_stage_history_tag();

CREATE OR REPLACE FUNCTION public.apply_messenger_lead_stage(p_page_id UUID,p_contact_id UUID,p_message_id TEXT,p_label TEXT,p_stage TEXT,p_occurred_at TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE current_contact public.contacts%ROWTYPE; event_id BIGINT; reset_at TIMESTAMPTZ;
BEGIN
    IF p_stage NOT IN ('new','engaged','collecting_details','qualified','not_qualified','converted','order_created','opted_out')
       OR p_stage IS NULL OR p_message_id IS NULL OR length(btrim(p_message_id)) NOT BETWEEN 1 AND 2000
       OR p_occurred_at IS NULL OR p_occurred_at>now()+interval '5 minutes' THEN RAISE EXCEPTION 'Invalid Messenger stage event'; END IF;
    SELECT * INTO current_contact FROM public.contacts WHERE id=p_contact_id AND page_id=p_page_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Contact does not belong to Page'; END IF;
    INSERT INTO public.messenger_lead_stage_events(page_id,contact_id,message_id,label,stage,occurred_at)
    VALUES(p_page_id,p_contact_id,p_message_id,btrim(p_label),p_stage,p_occurred_at)
    ON CONFLICT(page_id,message_id) DO NOTHING RETURNING id INTO event_id;
    IF event_id IS NULL THEN RETURN jsonb_build_object('applied',false,'reason','duplicate'); END IF;
    PERFORM public.add_contact_stage_history_tag(p_page_id,p_contact_id,p_label,p_stage);
    SELECT messenger_history_reset_at INTO reset_at FROM public.chatbot_contact_states WHERE page_id=p_page_id AND contact_id=p_contact_id;
    IF (current_contact.messenger_stage_event_at IS NOT NULL AND p_occurred_at<=current_contact.messenger_stage_event_at)
       OR (reset_at IS NOT NULL AND p_occurred_at<reset_at)
       OR (current_contact.pipeline_stage_source='manual' AND p_occurred_at<current_contact.pipeline_stage_updated_at) THEN
        RETURN jsonb_build_object('applied',false,'reason','older_event');
    END IF;
    UPDATE public.contacts SET pipeline_stage=p_stage,pipeline_stage_source='messenger',pipeline_stage_updated_at=NOW(),
        messenger_stage_label=btrim(p_label),messenger_stage_event_at=p_occurred_at,messenger_stage_message_id=p_message_id
    WHERE id=p_contact_id AND page_id=p_page_id;
    UPDATE public.messenger_lead_stage_events SET applied=TRUE WHERE id=event_id;
    RETURN jsonb_build_object('applied',true,'stage',p_stage,'label',btrim(p_label));
END; $$;

CREATE OR REPLACE FUNCTION public.claim_messenger_stage_pages(p_limit INTEGER DEFAULT 6)
RETURNS SETOF public.pages LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'Invalid Page batch size'; END IF;
    RETURN QUERY WITH due AS (
        SELECT p.id FROM public.pages p WHERE p.messaging_auto_tag_enabled
          AND (p.messaging_auto_tag_lease_until IS NULL OR p.messaging_auto_tag_lease_until<NOW())
          AND p.messaging_auto_tag_attempted_at<NOW()-interval '30 seconds'
        ORDER BY p.messaging_auto_tag_attempted_at,p.id LIMIT p_limit FOR UPDATE SKIP LOCKED
    ) UPDATE public.pages p SET messaging_auto_tag_attempted_at=NOW(),messaging_auto_tag_lease_until=NOW()+interval '4 minutes'
      FROM due WHERE p.id=due.id RETURNING p.*;
END; $$;

CREATE OR REPLACE FUNCTION public.repair_chatbot_page_outcome_tags(p_page_id UUID,p_limit INTEGER DEFAULT 250)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE row RECORD; added INTEGER=0;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Invalid repair limit'; END IF;
    FOR row IN SELECT c.id,c.pipeline_stage,CASE WHEN c.pipeline_stage_source='messenger' AND c.messenger_stage_label IS NOT NULL
        THEN c.messenger_stage_label ELSE initcap(replace(c.pipeline_stage,'_',' ')) END AS label
        FROM public.contacts c WHERE c.page_id=p_page_id AND c.pipeline_stage_source<>'system' AND NOT EXISTS(
            SELECT 1 FROM public.contact_tags ct JOIN public.tags t ON t.id=ct.tag_id
            WHERE ct.contact_id=c.id AND t.owner_id=p_page_id AND t.system_key LIKE 'stage_history:%'
              AND t.name='History: '||CASE WHEN c.pipeline_stage_source='messenger' AND c.messenger_stage_label IS NOT NULL
                THEN c.messenger_stage_label ELSE initcap(replace(c.pipeline_stage,'_',' ')) END
        ) ORDER BY c.id LIMIT p_limit FOR UPDATE OF c SKIP LOCKED
    LOOP
        PERFORM public.add_contact_stage_history_tag(p_page_id,row.id,row.label,row.pipeline_stage); added=added+1;
    END LOOP;
    RETURN added;
END; $$;

-- Backfill recorded decisions, leaving imported contacts with no stage decision alone.
INSERT INTO public.tags(name,color,owner_type,owner_id,page_id,is_default,system_key)
SELECT 'History: '||initcap(replace(stage,'_',' ')),'#64748b','page',p.id,p.id,FALSE,'stage_history:'||stage
FROM public.pages p CROSS JOIN (VALUES ('new'),('engaged'),('collecting_details'),('qualified'),('not_qualified'),('converted'),('order_created'),('opted_out')) AS stages(stage)
ON CONFLICT(owner_id,system_key) DO NOTHING;
INSERT INTO public.contact_tags(contact_id,tag_id)
SELECT observed.contact_id,t.id FROM (
    SELECT e.page_id,e.contact_id,e.stage FROM public.ad_lead_stage_events e WHERE e.source<>'system'
    UNION SELECT c.page_id,c.id,c.pipeline_stage FROM public.contacts c WHERE c.pipeline_stage_source<>'system'
) observed JOIN public.contacts c ON c.id=observed.contact_id AND c.page_id=observed.page_id
JOIN public.tags t ON t.owner_type='page' AND t.owner_id=observed.page_id AND t.system_key='stage_history:'||observed.stage
ON CONFLICT(contact_id,tag_id) DO NOTHING;

REVOKE ALL ON FUNCTION public.add_contact_stage_history_tag(UUID,UUID,TEXT,TEXT),public.capture_contact_stage_history_tag(),
    public.apply_messenger_lead_stage(UUID,UUID,TEXT,TEXT,TEXT,TIMESTAMPTZ),public.claim_messenger_stage_pages(INTEGER),
    public.repair_chatbot_page_outcome_tags(UUID,INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.add_contact_stage_history_tag(UUID,UUID,TEXT,TEXT),
    public.apply_messenger_lead_stage(UUID,UUID,TEXT,TEXT,TEXT,TIMESTAMPTZ),public.claim_messenger_stage_pages(INTEGER),
    public.repair_chatbot_page_outcome_tags(UUID,INTEGER) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
