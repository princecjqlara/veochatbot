-- Return all Page pipeline counts in one indexed scan for the funnel UI.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_contact_pipeline_counts(p_page_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
WITH stages(stage, ordinal) AS (
    VALUES
        ('new', 1),
        ('engaged', 2),
        ('collecting_details', 3),
        ('qualified', 4),
        ('order_created', 5),
        ('converted', 6),
        ('not_qualified', 7),
        ('opted_out', 8)
),
counts AS (
    SELECT pipeline_stage AS stage, COUNT(*)::INTEGER AS count
    FROM public.contacts
    WHERE page_id = p_page_id
    GROUP BY pipeline_stage
)
SELECT jsonb_object_agg(stages.stage, COALESCE(counts.count, 0) ORDER BY stages.ordinal)
FROM stages
LEFT JOIN counts USING (stage);
$$;

CREATE OR REPLACE FUNCTION public.get_chatbot_contact_metrics(
    p_page_id UUID,
    p_from TIMESTAMPTZ,
    p_to TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
WITH date_bounds AS (
    SELECT
        ((timezone('Asia/Manila', NOW()))::date::timestamp AT TIME ZONE 'Asia/Manila') AS today_start,
        (((timezone('Asia/Manila', NOW()))::date + 1)::timestamp AT TIME ZONE 'Asia/Manila') AS tomorrow_start
)
SELECT jsonb_build_object(
    'total', (
        SELECT COUNT(*)::INTEGER FROM public.contacts WHERE page_id = p_page_id
    ),
    'today', (
        SELECT COUNT(*)::INTEGER
        FROM public.contacts, date_bounds AS bounds
        WHERE page_id = p_page_id
          AND COALESCE(first_interaction_at, created_at) >= bounds.today_start
          AND COALESCE(first_interaction_at, created_at) < bounds.tomorrow_start
    ),
    'new_in_range', (
        SELECT COUNT(*)::INTEGER
        FROM public.contacts
        WHERE page_id = p_page_id
          AND COALESCE(first_interaction_at, created_at) >= p_from
          AND COALESCE(first_interaction_at, created_at) < p_to
    ),
    'active_in_range', (
        SELECT COUNT(*)::INTEGER
        FROM public.contacts
        WHERE page_id = p_page_id
          AND last_inbound_at >= p_from AND last_inbound_at < p_to
    ),
    'within_7_day_window', (
        SELECT COUNT(*)::INTEGER
        FROM public.contacts
        WHERE page_id = p_page_id
          AND last_inbound_at >= NOW() - INTERVAL '7 days'
    )
);
$$;

REVOKE ALL ON FUNCTION public.get_contact_pipeline_counts(UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_contact_pipeline_counts(UUID)
    TO postgres, service_role;

REVOKE ALL ON FUNCTION public.get_chatbot_contact_metrics(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_chatbot_contact_metrics(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
    TO postgres, service_role;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260922_004', 'Single-scan contact pipeline counts for the funnel dashboard')
ON CONFLICT (version) DO UPDATE SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';

COMMIT;
