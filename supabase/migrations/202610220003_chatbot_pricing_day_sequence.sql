-- One catalog during the first 24 hours; alternatives use later-day opportunities.
BEGIN;
ALTER TABLE public.chatbot_follow_up_jobs DROP CONSTRAINT IF EXISTS chatbot_follow_up_jobs_purpose_check;
ALTER TABLE public.chatbot_follow_up_jobs ADD CONSTRAINT chatbot_follow_up_jobs_purpose_check
    CHECK (purpose IN ('scheduled','nightly_continuation','first_day_adaptive','pricing_promotion'));
ALTER TABLE public.chatbot_follow_up_jobs DROP CONSTRAINT IF EXISTS chatbot_follow_up_jobs_status_check;
ALTER TABLE public.chatbot_follow_up_jobs ADD CONSTRAINT chatbot_follow_up_jobs_status_check
    CHECK (status IN ('pending','processing','ready_manual','waiting_response','sent','cancelled','failed'));
CREATE INDEX IF NOT EXISTS chatbot_pricing_waiting_response_jobs
    ON public.chatbot_follow_up_jobs(page_id,contact_id,due_at) WHERE purpose='pricing_promotion' AND status='waiting_response';

CREATE OR REPLACE FUNCTION public.reserve_chatbot_pricing_offer(
    p_page_id uuid, p_contact_id uuid, p_source_key text, p_follow_up boolean,
    p_quote_eligible boolean, p_duration_seconds integer DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    run public.chatbot_pricing_experiments%ROWTYPE;
    assignment public.chatbot_pricing_assignments%ROWTYPE;
    delivery public.chatbot_pricing_deliveries%ROWTYPE;
    package public.chatbot_pricing_packages%ROWTYPE;
    start_position integer; package_ids uuid[]; package_count integer; selected_id uuid;
    last_sent timestamptz; delivery_kind text := 'initial'; inbound_at timestamptz;
    uses_catalog boolean; selected_option jsonb;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('chatbot_pricing:' || p_page_id::text, 0));
    SELECT * INTO run FROM public.chatbot_pricing_experiments WHERE page_id = p_page_id AND status = 'active' FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF run.duration_seconds IS NOT NULL AND run.duration_seconds IS DISTINCT FROM p_duration_seconds THEN RETURN NULL; END IF;
    SELECT last_inbound_at INTO inbound_at FROM public.contacts WHERE id = p_contact_id AND page_id = p_page_id
        AND pipeline_stage NOT IN ('qualified','not_qualified','order_created','converted','opted_out')
        AND pipeline_stage_source NOT IN ('manual','messenger');
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF EXISTS (SELECT 1 FROM public.contact_tags ct JOIN public.tags t ON t.id = ct.tag_id
        WHERE ct.contact_id = p_contact_id AND t.owner_type = 'page' AND t.owner_id = p_page_id
        AND t.system_key IN ('qualified','not_qualified','order_created','converted')) THEN RETURN NULL; END IF;
    IF p_follow_up AND (inbound_at IS NULL OR inbound_at <= now() - interval '23 hours 59 minutes' OR inbound_at > now()) THEN RETURN NULL; END IF;
    SELECT EXISTS (SELECT 1 FROM public.chatbot_pricing_packages WHERE experiment_id = run.id AND jsonb_array_length(options) > 0) INTO uses_catalog;
    IF uses_catalog AND (p_duration_seconds IS NULL OR EXISTS (
        SELECT 1 FROM public.chatbot_pricing_packages p WHERE p.experiment_id = run.id AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(p.options) AS option WHERE (option->>'duration_seconds')::integer = p_duration_seconds
        ))) THEN RETURN NULL; END IF;
    SELECT * INTO assignment FROM public.chatbot_pricing_assignments WHERE experiment_id = run.id AND contact_id = p_contact_id;
    IF NOT FOUND THEN
        IF NOT p_quote_eligible THEN RETURN NULL; END IF;
        -- Keep pre-run customers on their established prices; enroll new inquiries only.
        IF NOT EXISTS (SELECT 1 FROM public.contacts WHERE id = p_contact_id AND page_id = p_page_id
            AND first_interaction_at >= run.created_at) THEN RETURN NULL; END IF;
        -- Existing offers from earlier runs must not be silently replaced for an ongoing customer.
        IF EXISTS (SELECT 1 FROM public.chatbot_pricing_assignments WHERE page_id = p_page_id AND contact_id = p_contact_id AND first_exposed_at IS NOT NULL) THEN RETURN NULL; END IF;
        SELECT count(*) INTO package_count FROM public.chatbot_pricing_packages WHERE experiment_id = run.id;
        SELECT p.id, p.position INTO selected_id, start_position FROM public.chatbot_pricing_packages p
        LEFT JOIN public.chatbot_pricing_assignments a ON a.initial_package_id = p.id
        WHERE p.experiment_id = run.id GROUP BY p.id, p.position
        ORDER BY CASE WHEN run.mode = 'sequence' THEN p.position ELSE count(a.id) FILTER (WHERE a.initial_duration_seconds IS NOT DISTINCT FROM p_duration_seconds) END, random() LIMIT 1;
        SELECT array_agg(id ORDER BY (position - start_position + package_count) % package_count) INTO package_ids
            FROM public.chatbot_pricing_packages WHERE experiment_id = run.id;
        INSERT INTO public.chatbot_pricing_assignments(experiment_id, page_id, contact_id, initial_package_id, package_order, initial_duration_seconds)
        VALUES (run.id, p_page_id, p_contact_id, selected_id, package_ids, p_duration_seconds) RETURNING * INTO assignment;
    END IF;
    SELECT * INTO delivery FROM public.chatbot_pricing_deliveries WHERE assignment_id = assignment.id AND source_key = p_source_key;
    IF FOUND AND delivery.status IN ('sending','sent') THEN RETURN jsonb_build_object('blocked', true); END IF;
    IF FOUND AND delivery.status = 'reserved' THEN
        SELECT * INTO package FROM public.chatbot_pricing_packages WHERE id = delivery.package_id;
    ELSE
        -- Do not leapfrog another in-flight offer, including a process crash with uncertain delivery.
        IF EXISTS (SELECT 1 FROM public.chatbot_pricing_deliveries WHERE assignment_id = assignment.id AND status IN ('reserved','sending')) THEN RETURN jsonb_build_object('blocked', true); END IF;
        SELECT max(sent_at) INTO last_sent FROM public.chatbot_pricing_deliveries WHERE assignment_id = assignment.id AND status = 'sent';
        selected_id := assignment.initial_package_id;
        IF NOT p_follow_up AND last_sent IS NOT NULL THEN
            SELECT package_id INTO selected_id FROM public.chatbot_pricing_deliveries
                WHERE assignment_id = assignment.id AND status = 'sent' ORDER BY sent_at DESC, reserved_at DESC, id DESC LIMIT 1;
        END IF;
        IF p_follow_up AND last_sent IS NOT NULL THEN
            IF run.mode = 'fair_test' OR assignment.first_exposed_at > now() - interval '24 hours'
                OR EXISTS (SELECT 1 FROM public.chatbot_pricing_deliveries d WHERE d.assignment_id = assignment.id
                    AND d.kind = 'promotion' AND d.status = 'sent' AND d.sent_at > now() - interval '24 hours')
                THEN RETURN NULL; END IF;
            SELECT candidate INTO selected_id FROM unnest(assignment.package_order) WITH ORDINALITY AS ordered(candidate, position)
            WHERE NOT EXISTS (SELECT 1 FROM public.chatbot_pricing_deliveries d WHERE d.assignment_id = assignment.id AND d.package_id = candidate AND d.status = 'sent')
            ORDER BY position LIMIT 1;
            IF selected_id IS NULL THEN RETURN NULL; END IF;
            delivery_kind := 'promotion';
        ELSIF NOT p_quote_eligible THEN RETURN NULL;
        END IF;
        SELECT * INTO package FROM public.chatbot_pricing_packages WHERE id = selected_id;
        SELECT option INTO selected_option FROM jsonb_array_elements(package.options) AS option
            WHERE (option->>'duration_seconds')::integer = p_duration_seconds LIMIT 1;
        INSERT INTO public.chatbot_pricing_deliveries(assignment_id, experiment_id, package_id, source_key, kind, duration_seconds, option_details)
        VALUES (assignment.id, run.id, selected_id, p_source_key, delivery_kind, coalesce(p_duration_seconds,run.duration_seconds), selected_option)
        ON CONFLICT (assignment_id, source_key) DO UPDATE SET status = 'reserved', reserved_at = now(),
            package_id = EXCLUDED.package_id, kind = EXCLUDED.kind, duration_seconds = EXCLUDED.duration_seconds, option_details = EXCLUDED.option_details
        RETURNING * INTO delivery;
    END IF;
    RETURN jsonb_build_object('delivery_id', delivery.id, 'experiment_id', run.id, 'assignment_id', assignment.id,
        'package_id', package.id, 'package_name', package.name, 'price', coalesce((delivery.option_details->>'price')::numeric,package.price), 'message', package.message,
        'hook', package.hook, 'option', delivery.option_details, 'duration_seconds', delivery.duration_seconds, 'kind', delivery.kind);
END; $$;

CREATE OR REPLACE FUNCTION public.chatbot_pricing_offer_is_active(p_delivery_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.chatbot_pricing_deliveries d
        JOIN public.chatbot_pricing_experiments e ON e.id = d.experiment_id
        JOIN public.chatbot_pricing_assignments a ON a.id = d.assignment_id
        JOIN public.contacts c ON c.id = a.contact_id AND c.page_id = a.page_id
        WHERE d.id = p_delivery_id AND d.status = 'reserved' AND e.status = 'active'
        AND c.pipeline_stage NOT IN ('qualified','not_qualified','order_created','converted','opted_out')
        AND c.pipeline_stage_source NOT IN ('manual','messenger')
        AND NOT EXISTS (SELECT 1 FROM public.contact_tags ct JOIN public.tags t ON t.id = ct.tag_id
            WHERE ct.contact_id = c.id AND t.owner_type = 'page' AND t.owner_id = c.page_id
            AND t.system_key IN ('qualified','not_qualified','order_created','converted'))
        AND (d.kind <> 'promotion' OR (
            a.first_exposed_at <= now() - interval '24 hours'
            AND c.last_inbound_at > now() - interval '23 hours 59 minutes' AND c.last_inbound_at <= now()
            AND NOT EXISTS (SELECT 1 FROM public.chatbot_pricing_deliveries previous WHERE previous.assignment_id = a.id
                AND previous.id <> d.id AND previous.kind = 'promotion' AND previous.status = 'sent'
                AND previous.sent_at > now() - interval '24 hours')
        ))
    );
$$;

CREATE OR REPLACE FUNCTION public.schedule_chatbot_pricing_promotion(
    p_page_id uuid, p_contact_id uuid, p_anchor_inbound_at timestamptz, p_days integer[],
    p_best_hour integer DEFAULT 12, p_epoch integer DEFAULT 0, p_revision integer DEFAULT 1
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    run public.chatbot_pricing_experiments%ROWTYPE; assignment public.chatbot_pricing_assignments%ROWTYPE;
    completed integer; package_count integer; day_number integer; valid_days integer[];
    latest_promotion timestamptz; target timestamptz; local_target timestamp; inserted_id uuid; job_status text;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('chatbot_pricing:' || p_page_id::text,0));
    SELECT * INTO run FROM public.chatbot_pricing_experiments WHERE page_id=p_page_id AND status='active';
    IF NOT FOUND THEN RETURN jsonb_build_object('managed',false,'scheduled',0); END IF;
    SELECT * INTO assignment FROM public.chatbot_pricing_assignments
        WHERE experiment_id=run.id AND contact_id=p_contact_id AND first_exposed_at IS NOT NULL;
    IF NOT FOUND THEN RETURN jsonb_build_object('managed',false,'scheduled',0); END IF;
    IF run.mode='fair_test' THEN RETURN jsonb_build_object('managed',true,'scheduled',0); END IF;
    IF NOT EXISTS (SELECT 1 FROM public.contacts c JOIN public.chatbot_configs b ON b.page_id=c.page_id
        LEFT JOIN public.chatbot_contact_states s ON s.page_id=c.page_id AND s.contact_id=c.id
        WHERE c.id=p_contact_id AND c.page_id=p_page_id AND c.last_inbound_at=p_anchor_inbound_at
        AND b.enabled AND b.follow_up_enabled AND (NOT b.trial_mode_enabled OR b.trial_contact_id=c.id)
        AND (s.status IS NULL OR s.status<>'stopped')
        AND c.pipeline_stage NOT IN ('qualified','not_qualified','order_created','converted','opted_out')
        AND c.pipeline_stage_source NOT IN ('manual','messenger')) THEN
        RETURN jsonb_build_object('managed',true,'scheduled',0);
    END IF;
    IF EXISTS (SELECT 1 FROM public.contact_tags ct JOIN public.tags t ON t.id=ct.tag_id
        WHERE ct.contact_id=p_contact_id AND t.owner_type='page' AND t.owner_id=p_page_id
        AND t.system_key IN ('qualified','not_qualified','order_created','converted')) THEN
        RETURN jsonb_build_object('managed',true,'scheduled',0);
    END IF;
    SELECT array_agg(day_value ORDER BY day_value) INTO valid_days
        FROM (SELECT DISTINCT unnest(p_days) AS day_value) configured_days WHERE day_value BETWEEN 2 AND 7;
    SELECT count(DISTINCT package_id) INTO completed FROM public.chatbot_pricing_deliveries
        WHERE assignment_id=assignment.id AND kind='promotion' AND status='sent';
    package_count:=cardinality(assignment.package_order);
    day_number:=valid_days[completed+1];
    IF completed>=package_count-1 OR day_number IS NULL THEN RETURN jsonb_build_object('managed',true,'scheduled',0); END IF;
    SELECT max(sent_at) INTO latest_promotion FROM public.chatbot_pricing_deliveries
        WHERE assignment_id=assignment.id AND kind='promotion' AND status='sent';
    local_target:=date_trunc('day',assignment.first_exposed_at AT TIME ZONE 'Asia/Manila')
        + make_interval(days=>day_number-1,hours=>greatest(0,least(23,coalesce(p_best_hour,12))));
    target:=greatest(local_target AT TIME ZONE 'Asia/Manila',assignment.first_exposed_at+interval '24 hours',
        coalesce(latest_promotion+interval '24 hours',assignment.first_exposed_at+interval '24 hours'),now()+interval '1 minute');
    IF target>=p_anchor_inbound_at+interval '23 hours 59 minutes' OR p_anchor_inbound_at>now() THEN
        job_status:='waiting_response';
    ELSE job_status:='pending'; END IF;
    INSERT INTO public.chatbot_follow_up_jobs(page_id,contact_id,anchor_inbound_at,schedule_type,sequence_index,
        due_at,message_text,status,purpose,automation_epoch,policy_revision,error_message)
    VALUES(p_page_id,p_contact_id,p_anchor_inbound_at,'response',completed,target,'Approved next catalog for a later pricing day',
        job_status,'pricing_promotion',p_epoch,p_revision,CASE WHEN job_status='waiting_response' THEN 'Waiting for an eligible Messenger response window' ELSE NULL END)
    ON CONFLICT(contact_id,anchor_inbound_at,schedule_type,sequence_index,automation_epoch,purpose) DO NOTHING RETURNING id INTO inserted_id;
    RETURN jsonb_build_object('managed',true,'scheduled',CASE WHEN inserted_id IS NULL THEN 0 ELSE 1 END,
        'due_at',target,'waiting_response',job_status='waiting_response','day',day_number);
END; $$;

REVOKE ALL ON FUNCTION public.schedule_chatbot_pricing_promotion(uuid,uuid,timestamptz,integer[],integer,integer,integer)
    FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_chatbot_pricing_promotion(uuid,uuid,timestamptz,integer[],integer,integer,integer)
    TO service_role;
INSERT INTO app_private.schema_migrations(version,description)
VALUES('20261022_003','Keep one price catalog in the first 24 hours and queue alternatives on later days')
ON CONFLICT(version) DO UPDATE SET description=EXCLUDED.description;
NOTIFY pgrst,'reload schema';
COMMIT;

