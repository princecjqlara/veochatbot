BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';

-- Meta can surface the same stage notice in more than one conversation on a
-- Page. Deduplicate within a contact so each affected lead gets its own event.
ALTER TABLE public.messenger_lead_stage_events
 DROP CONSTRAINT IF EXISTS messenger_lead_stage_events_page_id_message_id_key;
ALTER TABLE public.messenger_lead_stage_events
 ADD CONSTRAINT messenger_lead_stage_events_page_contact_message_key
 UNIQUE(page_id,contact_id,message_id);

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
    ON CONFLICT(page_id,contact_id,message_id) DO NOTHING RETURNING id INTO event_id;
    IF event_id IS NULL THEN RETURN jsonb_build_object('applied',false,'reason','duplicate'); END IF;
    PERFORM public.add_contact_stage_history_tag(p_page_id,p_contact_id,p_label,p_stage);
    SELECT messenger_history_reset_at INTO reset_at FROM public.chatbot_contact_states WHERE page_id=p_page_id AND contact_id=p_contact_id;
    IF (current_contact.messenger_stage_event_at IS NOT NULL AND p_occurred_at<=current_contact.messenger_stage_event_at)
       OR (reset_at IS NOT NULL AND p_occurred_at<reset_at)
       OR (current_contact.pipeline_stage_source='manual' AND p_occurred_at<current_contact.pipeline_stage_updated_at) THEN
        RETURN jsonb_build_object('applied',false,'reason','older_event','event_saved',true);
    END IF;
    UPDATE public.contacts SET pipeline_stage=p_stage,pipeline_stage_source='messenger',pipeline_stage_updated_at=NOW(),
        messenger_stage_label=btrim(p_label),messenger_stage_event_at=p_occurred_at,messenger_stage_message_id=p_message_id
    WHERE id=p_contact_id AND page_id=p_page_id;
    UPDATE public.messenger_lead_stage_events SET applied=TRUE WHERE id=event_id;
    RETURN jsonb_build_object('applied',true,'stage',p_stage,'label',btrim(p_label));
END; $$;

INSERT INTO app_private.schema_migrations(version,description)
VALUES('202611050007','Scope Messenger stage event deduplication to each contact')
ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
