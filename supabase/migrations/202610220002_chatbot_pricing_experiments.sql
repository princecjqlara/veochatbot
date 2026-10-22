-- Opt-in pricing runs. Creating a run does not enable the bot or its scheduler.
BEGIN;

CREATE TABLE IF NOT EXISTS public.chatbot_pricing_experiments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id uuid NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
    mode text NOT NULL CHECK (mode IN ('fair_test', 'sequence', 'fair_test_sequence')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
    duration_seconds integer CHECK (duration_seconds BETWEEN 1 AND 3600),
    follow_up_gap_minutes integer NOT NULL DEFAULT 120 CHECK (follow_up_gap_minutes BETWEEN 15 AND 1439),
    attribution_days integer NOT NULL DEFAULT 7 CHECK (attribution_days BETWEEN 1 AND 90),
    minimum_sample integer NOT NULL DEFAULT 100 CHECK (minimum_sample BETWEEN 10 AND 10000),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, page_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS chatbot_pricing_current_page ON public.chatbot_pricing_experiments(page_id)
    WHERE status <> 'archived';

CREATE TABLE IF NOT EXISTS public.chatbot_pricing_packages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    experiment_id uuid NOT NULL REFERENCES public.chatbot_pricing_experiments(id) ON DELETE CASCADE,
    position integer NOT NULL CHECK (position BETWEEN 0 AND 9),
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
    price numeric(12,2) NOT NULL CHECK (price > 0 AND price <= 10000000),
    hook text NOT NULL DEFAULT '' CHECK (length(hook) <= 160),
    options jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) <= 20),
    message text NOT NULL CHECK (length(btrim(message)) <= 1200),
    tag_id uuid REFERENCES public.tags(id) ON DELETE SET NULL,
    UNIQUE (experiment_id, position), UNIQUE (experiment_id, name), UNIQUE (id, experiment_id),
    CHECK (length(btrim(message)) > 0 OR jsonb_array_length(options) > 0)
);

CREATE TABLE IF NOT EXISTS public.chatbot_pricing_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    experiment_id uuid NOT NULL,
    page_id uuid NOT NULL,
    contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    initial_package_id uuid NOT NULL,
    initial_duration_seconds integer CHECK (initial_duration_seconds BETWEEN 1 AND 3600),
    package_order uuid[] NOT NULL,
    assigned_at timestamptz NOT NULL DEFAULT now(),
    first_exposed_at timestamptz,
    FOREIGN KEY (experiment_id, page_id) REFERENCES public.chatbot_pricing_experiments(id, page_id) ON DELETE CASCADE,
    FOREIGN KEY (initial_package_id, experiment_id) REFERENCES public.chatbot_pricing_packages(id, experiment_id) ON DELETE CASCADE,
    UNIQUE (experiment_id, contact_id), UNIQUE (id, experiment_id)
);
CREATE INDEX IF NOT EXISTS chatbot_pricing_assignments_contact ON public.chatbot_pricing_assignments(contact_id, first_exposed_at);
CREATE INDEX IF NOT EXISTS chatbot_pricing_assignments_variant ON public.chatbot_pricing_assignments(experiment_id, initial_package_id);

CREATE TABLE IF NOT EXISTS public.chatbot_pricing_deliveries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    assignment_id uuid NOT NULL,
    experiment_id uuid NOT NULL,
    package_id uuid NOT NULL,
    source_key text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 250),
    kind text NOT NULL CHECK (kind IN ('initial', 'promotion')),
    duration_seconds integer CHECK (duration_seconds BETWEEN 1 AND 3600),
    option_details jsonb,
    status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'sending', 'sent', 'released')),
    reserved_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz,
    message_id text,
    FOREIGN KEY (assignment_id, experiment_id) REFERENCES public.chatbot_pricing_assignments(id, experiment_id) ON DELETE CASCADE,
    FOREIGN KEY (package_id, experiment_id) REFERENCES public.chatbot_pricing_packages(id, experiment_id) ON DELETE CASCADE,
    UNIQUE (assignment_id, source_key),
    CHECK ((status = 'sent') = (sent_at IS NOT NULL AND message_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS chatbot_pricing_one_reservation ON public.chatbot_pricing_deliveries(assignment_id) WHERE status IN ('reserved','sending');
CREATE INDEX IF NOT EXISTS chatbot_pricing_delivered_package ON public.chatbot_pricing_deliveries(assignment_id, package_id, sent_at) WHERE status = 'sent';

CREATE TABLE IF NOT EXISTS public.chatbot_pricing_outcomes (
    assignment_id uuid NOT NULL REFERENCES public.chatbot_pricing_assignments(id) ON DELETE CASCADE,
    stage text NOT NULL CHECK (stage IN ('qualified', 'not_qualified', 'order_created', 'converted')),
    last_package_id uuid REFERENCES public.chatbot_pricing_packages(id) ON DELETE CASCADE,
    observed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (assignment_id, stage)
);

-- Also permit reapplying this migration after the initial single-price preview.
ALTER TABLE public.chatbot_pricing_packages
    ADD COLUMN IF NOT EXISTS hook text NOT NULL DEFAULT '' CHECK (length(hook) <= 160),
    ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) <= 20);
ALTER TABLE public.chatbot_pricing_packages DROP CONSTRAINT IF EXISTS chatbot_pricing_packages_message_check;
ALTER TABLE public.chatbot_pricing_packages ADD CONSTRAINT chatbot_pricing_packages_message_check
    CHECK (length(btrim(message)) <= 1200 AND (length(btrim(message)) > 0 OR jsonb_array_length(options) > 0));
ALTER TABLE public.chatbot_pricing_assignments ADD COLUMN IF NOT EXISTS initial_duration_seconds integer CHECK (initial_duration_seconds BETWEEN 1 AND 3600);
ALTER TABLE public.chatbot_pricing_deliveries
    ADD COLUMN IF NOT EXISTS duration_seconds integer CHECK (duration_seconds BETWEEN 1 AND 3600),
    ADD COLUMN IF NOT EXISTS option_details jsonb;
CREATE INDEX IF NOT EXISTS chatbot_pricing_duration_cohorts ON public.chatbot_pricing_assignments(experiment_id,initial_duration_seconds,initial_package_id);

-- A new immutable catalog creates a new run; old results and assignments remain reviewable.
CREATE OR REPLACE FUNCTION public.create_chatbot_pricing_experiment(p_page_id uuid, p_config jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    run_id uuid; package_id uuid; package_tag_id uuid; item jsonb; item_position integer := 0;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('chatbot_pricing:' || p_page_id::text, 0));
    IF jsonb_typeof(p_config->'packages') <> 'array' OR jsonb_array_length(p_config->'packages') > 10
       OR jsonb_array_length(p_config->'packages') < (CASE WHEN p_config->>'mode' = 'sequence' THEN 1 ELSE 2 END) THEN
        RAISE EXCEPTION 'Invalid package count';
    END IF;
    UPDATE public.chatbot_pricing_experiments SET status = 'archived' WHERE page_id = p_page_id AND status <> 'archived';
    INSERT INTO public.chatbot_pricing_experiments(page_id, name, mode, duration_seconds, follow_up_gap_minutes, attribution_days, minimum_sample)
    VALUES (p_page_id, p_config->>'name', p_config->>'mode', (p_config->>'duration_seconds')::integer,
        (p_config->>'follow_up_gap_minutes')::integer, (p_config->>'attribution_days')::integer, (p_config->>'minimum_sample')::integer)
    RETURNING id INTO run_id;
    FOR item IN SELECT value FROM jsonb_array_elements(p_config->'packages') LOOP
        package_id := gen_random_uuid();
        INSERT INTO public.tags(name, color, owner_type, owner_id, page_id, is_default)
        VALUES ('Price: ' || (p_config->>'name') || ' / ' || (item->>'name'), '#0891b2', 'page', p_page_id, p_page_id, false)
        RETURNING id INTO package_tag_id;
        INSERT INTO public.chatbot_pricing_packages(id, experiment_id, position, name, price, message, hook, options, tag_id)
        VALUES (package_id, run_id, item_position, item->>'name', (item->>'price')::numeric, item->>'message',
            coalesce(item->>'hook',''), coalesce(item->'options','[]'::jsonb), package_tag_id);
        item_position := item_position + 1;
    END LOOP;
    RETURN run_id;
END; $$;

-- Serializing selection per Page gives least-assigned allocation even under concurrent webhooks.
-- Ties are randomized. A contact's first package and cyclic follow-up order never change within a run.
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
            IF run.mode = 'fair_test' OR last_sent > now() - make_interval(mins => run.follow_up_gap_minutes) THEN RETURN NULL; END IF;
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

CREATE OR REPLACE FUNCTION public.get_chatbot_pricing_contact_catalog(p_page_id uuid, p_contact_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT jsonb_build_object('name', p.name, 'hook', p.hook, 'price', p.price, 'message', p.message, 'options', p.options)
    FROM public.chatbot_pricing_deliveries d
    JOIN public.chatbot_pricing_assignments a ON a.id = d.assignment_id
    JOIN public.chatbot_pricing_packages p ON p.id = d.package_id
    WHERE a.page_id = p_page_id AND a.contact_id = p_contact_id AND d.status = 'sent'
    ORDER BY d.sent_at DESC, d.reserved_at DESC, d.id DESC LIMIT 1;
$$;

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
        AND (d.kind <> 'promotion' OR (c.last_inbound_at > now() - interval '23 hours 59 minutes' AND c.last_inbound_at <= now()))
    );
$$;

CREATE OR REPLACE FUNCTION public.finish_chatbot_pricing_delivery(p_delivery_id uuid, p_message_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE delivery public.chatbot_pricing_deliveries%ROWTYPE; assignment public.chatbot_pricing_assignments%ROWTYPE; package_tag_id uuid;
BEGIN
    IF nullif(btrim(p_message_id), '') IS NULL THEN RAISE EXCEPTION 'A sent Messenger message ID is required'; END IF;
    SELECT * INTO delivery FROM public.chatbot_pricing_deliveries WHERE id = p_delivery_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pricing delivery not found'; END IF;
    IF delivery.status = 'sent' THEN RETURN; END IF;
    UPDATE public.chatbot_pricing_deliveries SET status = 'sent', sent_at = now(), message_id = p_message_id WHERE id = delivery.id;
    UPDATE public.chatbot_pricing_assignments SET first_exposed_at = coalesce(first_exposed_at, now()) WHERE id = delivery.assignment_id RETURNING * INTO assignment;
    SELECT tag_id INTO package_tag_id FROM public.chatbot_pricing_packages WHERE id = delivery.package_id;
    IF package_tag_id IS NOT NULL THEN
        INSERT INTO public.contact_tags(contact_id, tag_id) VALUES (assignment.contact_id, package_tag_id) ON CONFLICT (contact_id, tag_id) DO NOTHING;
    END IF;
END; $$;

CREATE OR REPLACE FUNCTION public.begin_chatbot_pricing_delivery(p_delivery_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    UPDATE public.chatbot_pricing_deliveries SET status = 'sending'
        WHERE id = p_delivery_id AND status = 'reserved' AND public.chatbot_pricing_offer_is_active(p_delivery_id);
    RETURN FOUND;
END; $$;

CREATE OR REPLACE FUNCTION public.release_chatbot_pricing_offer(p_delivery_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE public.chatbot_pricing_deliveries SET status = 'released' WHERE id = p_delivery_id AND status = 'reserved';
$$;

-- Observe real pipeline changes and system outcome tags. Exposure alone never creates an outcome.
CREATE OR REPLACE FUNCTION public.capture_chatbot_pricing_outcome(p_contact_id uuid, p_stage text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE assignment record; last_package uuid;
BEGIN
    IF p_stage NOT IN ('qualified','not_qualified','order_created','converted') THEN RETURN; END IF;
    FOR assignment IN SELECT a.id FROM public.chatbot_pricing_assignments a
        JOIN public.chatbot_pricing_experiments e ON e.id = a.experiment_id
        WHERE a.contact_id = p_contact_id AND a.first_exposed_at IS NOT NULL
        AND now() >= a.first_exposed_at AND now() < a.first_exposed_at + make_interval(days => e.attribution_days)
    LOOP
        SELECT package_id INTO last_package FROM public.chatbot_pricing_deliveries
            WHERE assignment_id = assignment.id AND status = 'sent' AND sent_at <= now() ORDER BY sent_at DESC, id DESC LIMIT 1;
        INSERT INTO public.chatbot_pricing_outcomes(assignment_id, stage, last_package_id)
        VALUES (assignment.id, p_stage, last_package) ON CONFLICT DO NOTHING;
        IF p_stage IN ('order_created','converted') THEN
            INSERT INTO public.chatbot_pricing_outcomes(assignment_id, stage, last_package_id)
            VALUES (assignment.id, 'qualified', last_package) ON CONFLICT DO NOTHING;
        END IF;
    END LOOP;
END; $$;

CREATE OR REPLACE FUNCTION public.chatbot_pricing_pipeline_outcome_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF NEW.pipeline_stage IS DISTINCT FROM OLD.pipeline_stage THEN
        PERFORM public.capture_chatbot_pricing_outcome(NEW.id, NEW.pipeline_stage);
    END IF;
    RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS chatbot_pricing_pipeline_outcome ON public.contacts;
CREATE TRIGGER chatbot_pricing_pipeline_outcome AFTER UPDATE OF pipeline_stage ON public.contacts
    FOR EACH ROW EXECUTE FUNCTION public.chatbot_pricing_pipeline_outcome_trigger();

CREATE OR REPLACE FUNCTION public.chatbot_pricing_tag_outcome_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE outcome text;
BEGIN
    SELECT t.system_key INTO outcome FROM public.tags t JOIN public.contacts c ON c.id = NEW.contact_id
        WHERE t.id = NEW.tag_id AND t.owner_type = 'page' AND t.owner_id = c.page_id;
    IF outcome IS NOT NULL THEN PERFORM public.capture_chatbot_pricing_outcome(NEW.contact_id, outcome); END IF;
    RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS chatbot_pricing_tag_outcome ON public.contact_tags;
CREATE TRIGGER chatbot_pricing_tag_outcome AFTER INSERT ON public.contact_tags
    FOR EACH ROW EXECUTE FUNCTION public.chatbot_pricing_tag_outcome_trigger();

DROP FUNCTION IF EXISTS public.get_chatbot_pricing_analytics(uuid,uuid);
CREATE OR REPLACE FUNCTION public.get_chatbot_pricing_analytics(p_page_id uuid, p_experiment_id uuid, p_duration_seconds integer DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH scoped AS (
        SELECT a.* FROM public.chatbot_pricing_assignments a WHERE a.page_id = p_page_id AND a.experiment_id = p_experiment_id
            AND (p_duration_seconds IS NULL OR a.initial_duration_seconds = p_duration_seconds)
    ), cohorts AS (
        SELECT a.initial_package_id, count(*) AS assigned, count(a.first_exposed_at) AS exposed,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.chatbot_pricing_outcomes o WHERE o.assignment_id = a.id AND stage = 'qualified')) AS qualified,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.chatbot_pricing_outcomes o WHERE o.assignment_id = a.id AND stage = 'order_created')) AS orders,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.chatbot_pricing_outcomes o WHERE o.assignment_id = a.id AND stage = 'converted')) AS converted,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.chatbot_pricing_outcomes o WHERE o.assignment_id = a.id AND stage = 'not_qualified')) AS not_qualified
        FROM scoped a GROUP BY a.initial_package_id
    ), exposures AS (
        SELECT d.package_id, count(DISTINCT d.assignment_id) AS shown,
            count(*) FILTER (WHERE d.kind = 'promotion') AS promotional_sends
        FROM public.chatbot_pricing_deliveries d JOIN scoped a ON a.id = d.assignment_id WHERE d.status = 'sent' GROUP BY d.package_id
    ), touches AS (
        SELECT o.last_package_id, count(*) FILTER (WHERE o.stage = 'converted') AS last_touch_converted,
            count(*) FILTER (WHERE o.stage = 'qualified') AS last_touch_qualified,
            count(*) FILTER (WHERE o.stage = 'order_created') AS last_touch_orders
        FROM public.chatbot_pricing_outcomes o JOIN scoped a ON a.id = o.assignment_id GROUP BY o.last_package_id
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'package_id', p.id, 'assigned', coalesce(c.assigned,0), 'exposed', coalesce(c.exposed,0),
        'qualified', coalesce(c.qualified,0), 'orders', coalesce(c.orders,0), 'converted', coalesce(c.converted,0), 'not_qualified', coalesce(c.not_qualified,0),
        'shown', coalesce(x.shown,0), 'promotional_sends', coalesce(x.promotional_sends,0),
        'last_touch_converted', coalesce(t.last_touch_converted,0), 'last_touch_qualified', coalesce(t.last_touch_qualified,0), 'last_touch_orders', coalesce(t.last_touch_orders,0)
    ) ORDER BY p.position), '[]'::jsonb)
    FROM public.chatbot_pricing_packages p JOIN public.chatbot_pricing_experiments e ON e.id = p.experiment_id
    LEFT JOIN cohorts c ON c.initial_package_id = p.id LEFT JOIN exposures x ON x.package_id = p.id LEFT JOIN touches t ON t.last_package_id = p.id
    WHERE e.page_id = p_page_id AND e.id = p_experiment_id;
$$;

ALTER TABLE public.chatbot_pricing_experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chatbot_pricing_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chatbot_pricing_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chatbot_pricing_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chatbot_pricing_outcomes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chatbot_pricing_experiments, public.chatbot_pricing_packages, public.chatbot_pricing_assignments,
    public.chatbot_pricing_deliveries, public.chatbot_pricing_outcomes FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.chatbot_pricing_experiments, public.chatbot_pricing_packages, public.chatbot_pricing_assignments,
    public.chatbot_pricing_deliveries, public.chatbot_pricing_outcomes TO service_role;

REVOKE ALL ON FUNCTION public.create_chatbot_pricing_experiment(uuid,jsonb),
    public.reserve_chatbot_pricing_offer(uuid,uuid,text,boolean,boolean,integer),
    public.get_chatbot_pricing_contact_catalog(uuid,uuid),
    public.chatbot_pricing_offer_is_active(uuid), public.begin_chatbot_pricing_delivery(uuid), public.finish_chatbot_pricing_delivery(uuid,text),
    public.release_chatbot_pricing_offer(uuid), public.capture_chatbot_pricing_outcome(uuid,text),
    public.get_chatbot_pricing_analytics(uuid,uuid,integer), public.chatbot_pricing_pipeline_outcome_trigger(),
    public.chatbot_pricing_tag_outcome_trigger() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_chatbot_pricing_experiment(uuid,jsonb),
    public.reserve_chatbot_pricing_offer(uuid,uuid,text,boolean,boolean,integer),
    public.get_chatbot_pricing_contact_catalog(uuid,uuid),
    public.chatbot_pricing_offer_is_active(uuid), public.begin_chatbot_pricing_delivery(uuid), public.finish_chatbot_pricing_delivery(uuid,text),
    public.release_chatbot_pricing_offer(uuid), public.capture_chatbot_pricing_outcome(uuid,text),
    public.get_chatbot_pricing_analytics(uuid,uuid,integer) TO service_role;

INSERT INTO app_private.schema_migrations(version, description)
VALUES ('20261022_002', 'Balanced chatbot pricing experiments, progressive offers and outcome attribution')
ON CONFLICT (version) DO UPDATE SET description = EXCLUDED.description;
NOTIFY pgrst, 'reload schema';
COMMIT;
