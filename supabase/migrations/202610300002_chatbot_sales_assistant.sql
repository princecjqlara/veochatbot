-- Sales guidance only. No handoff, assignment, ownership or scheduling functions change.
BEGIN;
ALTER TABLE public.chatbot_configs ADD COLUMN IF NOT EXISTS sales_assistant_settings jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(sales_assistant_settings) = 'object');
ALTER TABLE public.chatbot_contact_states ADD COLUMN IF NOT EXISTS sales_progress jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(sales_progress) = 'object');
ALTER TABLE public.chatbot_follow_up_jobs DROP CONSTRAINT IF EXISTS chatbot_follow_up_jobs_purpose_check;
ALTER TABLE public.chatbot_follow_up_jobs ADD CONSTRAINT chatbot_follow_up_jobs_purpose_check
    CHECK (purpose IN ('scheduled','nightly_continuation','first_day_adaptive','pricing_promotion','form_submission'));

-- A lock on the existing contact serializes first writes as well as corrections.
-- This function cannot resume, stop, assign or notify a conversation.
CREATE OR REPLACE FUNCTION public.merge_chatbot_sales_details(
    p_page_id uuid, p_contact_id uuid, p_patch jsonb, p_base jsonb,
    p_source text, p_event_key text, p_observed_at timestamptz, p_progress jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.chatbot_contact_states; k text; v jsonb; conflicts jsonb := '[]';
    sources jsonb; events jsonb; progress jsonb; old_at timestamptz;
BEGIN
    IF p_source NOT IN ('chat','form','delivery') OR jsonb_typeof(p_patch) <> 'object' OR jsonb_typeof(p_base) <> 'object'
        OR jsonb_typeof(p_progress) <> 'object' OR length(p_event_key) NOT BETWEEN 1 AND 200
        OR p_observed_at IS NULL THEN RAISE EXCEPTION 'Invalid sales update'; END IF;
    PERFORM 1 FROM public.contacts WHERE id = p_contact_id AND page_id = p_page_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Contact not found'; END IF;
    INSERT INTO public.chatbot_contact_states(page_id, contact_id) VALUES (p_page_id, p_contact_id)
        ON CONFLICT (page_id, contact_id) DO NOTHING;
    SELECT * INTO s FROM public.chatbot_contact_states WHERE page_id = p_page_id AND contact_id = p_contact_id FOR UPDATE;
    events := COALESCE(s.sales_progress->'processed_events', '[]');
    IF events ? p_event_key THEN RETURN jsonb_build_object('state', to_jsonb(s), 'conflicts', conflicts, 'duplicate', true); END IF;
    sources := COALESCE(s.sales_progress->'field_sources', '{}');
    FOR k, v IN SELECT * FROM jsonb_each(p_patch) LOOP
        IF jsonb_typeof(v) <> 'string' OR length(trim(v #>> '{}')) NOT BETWEEN 1 AND 500 OR length(k) > 80 THEN CONTINUE; END IF;
        old_at := NULLIF(sources->k->>'observed_at','')::timestamptz;
        -- A stale chat result must not erase a newer form answer. Conflicting
        -- form edits return 409 for explicit customer review; disjoint edits merge.
        IF (old_at IS NOT NULL AND old_at > p_observed_at) OR
            (s.collected_details ? k AND s.collected_details->k IS DISTINCT FROM p_base->k AND s.collected_details->k IS DISTINCT FROM v) THEN
            conflicts := conflicts || jsonb_build_array(k); CONTINUE;
        END IF;
        s.collected_details := jsonb_set(s.collected_details, ARRAY[k], v);
        sources := jsonb_set(sources, ARRAY[k], jsonb_build_object('source',p_source,'observed_at',p_observed_at,'confirmed',true));
    END LOOP;
    progress := s.sales_progress || p_progress || jsonb_build_object('field_sources', sources);
    -- Keep receipts for recent updates; Messenger's existing event claim remains
    -- the primary durable delivery deduplication mechanism.
    SELECT COALESCE(jsonb_agg(value), '[]') INTO events FROM
        (SELECT value FROM jsonb_array_elements(events || jsonb_build_array(p_event_key)) WITH ORDINALITY e(value,n)
         ORDER BY n DESC LIMIT 100) recent;
    progress := progress || jsonb_build_object('processed_events', events);
    FOR k IN SELECT unnest(ARRAY['samples_sent','recommended_samples','freebies_presented']) LOOP
        IF p_progress ? k THEN
            SELECT COALESCE(jsonb_agg(DISTINCT value), '[]') INTO v
                FROM jsonb_array_elements(COALESCE(s.sales_progress->k,'[]') || (p_progress->k));
            progress := jsonb_set(progress, ARRAY[k], v);
        END IF;
    END LOOP;
    UPDATE public.chatbot_contact_states SET collected_details = s.collected_details, sales_progress = progress
        WHERE page_id = p_page_id AND contact_id = p_contact_id RETURNING * INTO s;
    RETURN jsonb_build_object('state', to_jsonb(s), 'conflicts', conflicts, 'duplicate', false);
END $$;
REVOKE ALL ON FUNCTION public.merge_chatbot_sales_details(uuid,uuid,jsonb,jsonb,text,text,timestamptz,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_chatbot_sales_details(uuid,uuid,jsonb,jsonb,text,text,timestamptz,jsonb) TO service_role;

-- Reserve the configured number of follow-ups atomically, even when cron
-- workers overlap. Retrying the same existing job does not consume another slot.
CREATE OR REPLACE FUNCTION public.reserve_chatbot_sales_follow_up(
    p_page_id uuid, p_contact_id uuid, p_anchor timestamptz, p_job_id uuid, p_max integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.chatbot_contact_states; attempts jsonb; ids jsonb;
BEGIN
    IF p_max IS NULL OR p_max < 0 OR p_max > 30 OR p_anchor IS NULL OR p_job_id IS NULL THEN RETURN false; END IF;
    PERFORM 1 FROM contacts WHERE id=p_contact_id AND page_id=p_page_id FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    SELECT * INTO s FROM chatbot_contact_states WHERE page_id=p_page_id AND contact_id=p_contact_id FOR UPDATE;
    IF NOT FOUND OR s.status <> 'active' THEN RETURN false; END IF;
    attempts := COALESCE(s.sales_progress->'follow_up_attempts','{}');
    ids := CASE WHEN (attempts->>'anchor')::timestamptz = p_anchor THEN COALESCE(attempts->'ids','[]') ELSE '[]' END;
    IF ids ? p_job_id::text THEN RETURN true; END IF;
    IF jsonb_array_length(ids) >= p_max THEN RETURN false; END IF;
    UPDATE chatbot_contact_states SET sales_progress = sales_progress || jsonb_build_object('follow_up_attempts',
        jsonb_build_object('anchor',p_anchor,'ids',ids || jsonb_build_array(p_job_id::text)))
        WHERE page_id=p_page_id AND contact_id=p_contact_id;
    RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.reserve_chatbot_sales_follow_up(uuid,uuid,timestamptz,uuid,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_chatbot_sales_follow_up(uuid,uuid,timestamptz,uuid,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
