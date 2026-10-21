BEGIN;

ALTER TABLE public.chatbot_contact_states
    ADD COLUMN IF NOT EXISTS messenger_history_reset_at timestamptz;

-- Only called after authorization of an explicit Page-owner reset.
CREATE OR REPLACE FUNCTION public.reset_chatbot_contact(p_page_id uuid, p_contact_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
    v_contact contacts%ROWTYPE;
    v_state chatbot_contact_states%ROWTYPE;
    v_id uuid;
    v_now timestamptz := clock_timestamp();
    v_missing jsonb;
BEGIN
    SELECT * INTO v_contact FROM contacts WHERE id=p_contact_id AND page_id=p_page_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Contact not found on this Page'; END IF;
    SELECT * INTO v_state FROM chatbot_contact_states WHERE contact_id=p_contact_id AND page_id=p_page_id FOR UPDATE;
    SELECT details_to_collect INTO v_missing FROM chatbot_configs WHERE page_id=p_page_id;

    UPDATE chatbot_follow_up_jobs SET status='cancelled',claimed_at=NULL,cancelled_at=v_now,
        error_message='Reset from live Messenger trial controls',updated_at=v_now
        WHERE page_id=p_page_id AND contact_id=p_contact_id AND status IN ('pending','processing','ready_manual');
    -- Retire the old intake and its continuation reviews; never replay old jobs.
    DELETE FROM chatbot_contact_states WHERE page_id=p_page_id AND contact_id=p_contact_id;
    INSERT INTO chatbot_contact_states(page_id,contact_id,status,started_at,window_expires_at,
        collected_details,missing_details,last_inbound_at,automation_epoch,last_human_activity_at,
        automation_resumed_at,messenger_history_reset_at)
    VALUES(p_page_id,p_contact_id,'active',v_now,COALESCE(v_contact.last_inbound_at,v_now)+interval '7 days',
        '{}'::jsonb,COALESCE(v_missing,'[]'::jsonb),v_contact.last_inbound_at,COALESCE(v_state.automation_epoch,0)+1,
        v_state.last_human_activity_at,v_now,v_now) RETURNING id INTO v_id;
    UPDATE contacts SET pipeline_stage='engaged',pipeline_stage_source='system',pipeline_stage_updated_at=v_now
        WHERE id=p_contact_id AND page_id=p_page_id;
    RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.reset_chatbot_contact(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reset_chatbot_contact(uuid,uuid) TO service_role;
INSERT INTO app_private.schema_migrations(version,description)
VALUES('20261017_002','Explicit chatbot resets acknowledge old Messenger stages and invalidate old work')
ON CONFLICT(version) DO UPDATE SET description=EXCLUDED.description;
NOTIFY pgrst,'reload schema';
COMMIT;
