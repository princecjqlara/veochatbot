-- Fast Page-scoped chatbot analytics for the dashboard.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_chatbot_activity_analytics(
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
WITH
period_states AS (
    SELECT
        state.*,
        (SELECT COUNT(*)::INTEGER FROM jsonb_object_keys(COALESCE(state.collected_details, '{}'::jsonb))) AS detail_count,
        CASE WHEN jsonb_typeof(state.missing_details) = 'array'
            THEN jsonb_array_length(state.missing_details)
            ELSE 0
        END AS missing_count
    FROM public.chatbot_contact_states AS state
    WHERE state.page_id = p_page_id
      AND COALESCE(state.last_inbound_at, state.started_at, state.created_at) >= p_from
      AND COALESCE(state.last_inbound_at, state.started_at, state.created_at) < p_to
),
state_metrics AS (
    SELECT
        COUNT(*)::INTEGER AS conversations,
        COUNT(*) FILTER (WHERE detail_count > 0)::INTEGER AS contacts_with_details,
        COALESCE(SUM(detail_count), 0)::INTEGER AS details_collected,
        COALESCE(SUM(missing_count), 0)::INTEGER AS details_missing,
        ROUND(COALESCE(AVG(detail_count), 0), 2) AS average_details_per_contact,
        COUNT(*) FILTER (
            WHERE stop_reason IN ('details_collected', 'qualified', 'order_created', 'converted')
        )::INTEGER AS completed_or_qualified,
        COUNT(*) FILTER (WHERE last_inbound_at IS NOT NULL)::INTEGER AS response_eligible,
        COUNT(*) FILTER (
            WHERE last_inbound_at IS NOT NULL
              AND last_bot_reply_at IS NOT NULL
              AND last_bot_reply_at >= last_inbound_at
        )::INTEGER AS latest_inbound_replied
    FROM period_states
),
current_state_metrics AS (
    SELECT
        COUNT(*) FILTER (WHERE status = 'active')::INTEGER AS active,
        COUNT(*) FILTER (WHERE status = 'stopped')::INTEGER AS stopped,
        COUNT(*)::INTEGER AS total
    FROM public.chatbot_contact_states
    WHERE page_id = p_page_id
),
stop_reason_counts AS (
    SELECT stop_reason, COUNT(*)::INTEGER AS count
    FROM period_states
    WHERE stop_reason IS NOT NULL
    GROUP BY stop_reason
),
stop_reasons AS (
    SELECT COALESCE(jsonb_object_agg(stop_reason, count), '{}'::jsonb) AS value
    FROM stop_reason_counts
),
reply_metrics AS (
    SELECT
        COUNT(*)::INTEGER AS claimed,
        COUNT(*) FILTER (WHERE status = 'sent')::INTEGER AS sent,
        COUNT(*) FILTER (WHERE status = 'failed')::INTEGER AS failed,
        COUNT(DISTINCT contact_id) FILTER (WHERE status = 'sent')::INTEGER AS contacts_replied
    FROM public.chatbot_reply_events
    WHERE page_id = p_page_id
      AND created_at >= p_from AND created_at < p_to
),
outbound_metrics AS (
    SELECT
        COUNT(*)::INTEGER AS total,
        COUNT(*) FILTER (
            WHERE COALESCE(source_name, '') NOT ILIKE '%follow-up%'
              AND COALESCE(message_kind, '') NOT ILIKE '%attachment%'
        )::INTEGER AS conversation_replies,
        COUNT(*) FILTER (WHERE COALESCE(message_kind, '') ILIKE '%attachment%')::INTEGER AS media_attachments
    FROM public.outbound_message_events
    WHERE page_id = p_page_id
      AND source_type = 'chatbot'
      AND sent_at >= p_from AND sent_at < p_to
),
follow_up_metrics AS (
    SELECT
        COUNT(*) FILTER (WHERE created_at >= p_from AND created_at < p_to)::INTEGER AS scheduled,
        COUNT(*) FILTER (WHERE status = 'pending')::INTEGER AS pending_now,
        COUNT(*) FILTER (WHERE sent_at >= p_from AND sent_at < p_to)::INTEGER AS sent,
        COUNT(*) FILTER (
            WHERE sent_at >= p_from AND sent_at < p_to AND schedule_type = 'response'
        )::INTEGER AS quick_sent,
        COUNT(*) FILTER (
            WHERE sent_at >= p_from AND sent_at < p_to AND schedule_type = 'human_agent'
        )::INTEGER AS human_agent_sent,
        COUNT(*) FILTER (
            WHERE updated_at >= p_from AND updated_at < p_to AND status = 'failed'
        )::INTEGER AS failed,
        COUNT(*) FILTER (
            WHERE updated_at >= p_from AND updated_at < p_to AND status = 'cancelled'
        )::INTEGER AS cancelled,
        COUNT(*) FILTER (
            WHERE sent_at >= p_from AND sent_at < p_to AND media_asset_id IS NOT NULL
        )::INTEGER AS with_media
    FROM public.chatbot_follow_up_jobs
    WHERE page_id = p_page_id
),
last_follow_up_per_contact AS (
    SELECT contact_id, MAX(sent_at) AS last_sent_at
    FROM public.chatbot_follow_up_jobs
    WHERE page_id = p_page_id
      AND status = 'sent'
      AND sent_at >= p_from AND sent_at < p_to
    GROUP BY contact_id
),
follow_up_response_metrics AS (
    SELECT
        COUNT(*)::INTEGER AS contacted,
        COUNT(*) FILTER (WHERE contact.last_inbound_at > follow_up.last_sent_at)::INTEGER AS responded
    FROM last_follow_up_per_contact AS follow_up
    INNER JOIN public.contacts AS contact ON contact.id = follow_up.contact_id
),
knowledge_metrics AS (
    SELECT
        COUNT(*)::INTEGER AS documents,
        COUNT(*) FILTER (WHERE status = 'ready')::INTEGER AS ready_documents,
        COALESCE(SUM(chunk_count) FILTER (WHERE status = 'ready'), 0)::INTEGER AS ready_chunks,
        COUNT(*) FILTER (WHERE status = 'failed')::INTEGER AS failed_documents
    FROM public.chatbot_knowledge_documents
    WHERE page_id = p_page_id
),
media_metrics AS (
    SELECT
        COUNT(*)::INTEGER AS assets,
        COUNT(*) FILTER (WHERE status = 'ready')::INTEGER AS ready_assets,
        COUNT(*) FILTER (WHERE status = 'ready' AND media_type = 'image')::INTEGER AS ready_images,
        COUNT(*) FILTER (WHERE status = 'ready' AND media_type = 'video')::INTEGER AS ready_videos,
        COUNT(*) FILTER (WHERE status = 'failed')::INTEGER AS failed_assets
    FROM public.chatbot_media_assets
    WHERE page_id = p_page_id
),
configuration AS (
    SELECT jsonb_build_object(
        'saved', config.page_id IS NOT NULL,
        'enabled', COALESCE(config.enabled, FALSE),
        'follow_up_enabled', COALESCE(config.follow_up_enabled, FALSE),
        'rag_enabled', COALESCE(config.rag_enabled, FALSE),
        'details_requested', CASE
            WHEN jsonb_typeof(config.details_to_collect) = 'array' THEN jsonb_array_length(config.details_to_collect)
            ELSE 0
        END,
        'details_completion_percent', COALESCE(config.details_completion_percent, 100),
        'model', config.model
    ) AS value
    FROM (SELECT 1) AS singleton
    LEFT JOIN public.chatbot_configs AS config ON config.page_id = p_page_id
)
SELECT jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'generated_at', NOW(),
    'conversations', (SELECT to_jsonb(metric) FROM state_metrics AS metric),
    'current_states', (SELECT to_jsonb(metric) FROM current_state_metrics AS metric),
    'stop_reasons', (SELECT value FROM stop_reasons),
    'reply_events', (SELECT to_jsonb(metric) FROM reply_metrics AS metric),
    'outbound', (SELECT to_jsonb(metric) FROM outbound_metrics AS metric),
    'follow_ups', (
        SELECT to_jsonb(delivery) || to_jsonb(response)
        FROM follow_up_metrics AS delivery
        CROSS JOIN follow_up_response_metrics AS response
    ),
    'knowledge', (SELECT to_jsonb(metric) FROM knowledge_metrics AS metric),
    'media', (SELECT to_jsonb(metric) FROM media_metrics AS metric),
    'configuration', (SELECT value FROM configuration)
);
$$;

CREATE OR REPLACE FUNCTION public.get_chatbot_contact_analytics(
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
WITH
date_bounds AS (
    SELECT
        ((timezone('Asia/Manila', NOW()))::date::timestamp AT TIME ZONE 'Asia/Manila') AS today_start,
        (((timezone('Asia/Manila', NOW()))::date + 1)::timestamp AT TIME ZONE 'Asia/Manila') AS tomorrow_start
),
contact_metrics AS (
    SELECT
        (SELECT COUNT(*)::INTEGER
         FROM public.contacts
         WHERE page_id = p_page_id) AS total,
        (SELECT COUNT(*)::INTEGER
         FROM public.contacts, date_bounds AS bounds
         WHERE page_id = p_page_id
           AND COALESCE(first_interaction_at, created_at) >= bounds.today_start
           AND COALESCE(first_interaction_at, created_at) < bounds.tomorrow_start) AS today,
        (SELECT COUNT(*)::INTEGER
         FROM public.contacts
         WHERE page_id = p_page_id
           AND COALESCE(first_interaction_at, created_at) >= p_from
           AND COALESCE(first_interaction_at, created_at) < p_to) AS new_in_range,
        (SELECT COUNT(*)::INTEGER
         FROM public.contacts
         WHERE page_id = p_page_id
           AND last_inbound_at >= p_from AND last_inbound_at < p_to) AS active_in_range,
        (SELECT COUNT(*)::INTEGER
         FROM public.contacts
         WHERE page_id = p_page_id
           AND last_inbound_at >= NOW() - INTERVAL '7 days') AS within_7_day_window
),
pipeline_stages(stage, ordinal) AS (
    VALUES
        ('new', 1), ('engaged', 2), ('collecting_details', 3), ('qualified', 4),
        ('order_created', 5), ('converted', 6), ('not_qualified', 7), ('opted_out', 8)
),
pipeline_counts AS (
    SELECT stage.stage, stage.ordinal, COUNT(contact.id)::INTEGER AS count
    FROM pipeline_stages AS stage
    LEFT JOIN public.contacts AS contact
      ON contact.page_id = p_page_id AND contact.pipeline_stage = stage.stage
    GROUP BY stage.stage, stage.ordinal
),
pipeline AS (
    SELECT jsonb_object_agg(stage, count ORDER BY ordinal) AS value
    FROM pipeline_counts
)
SELECT jsonb_build_object(
    'contacts', (SELECT to_jsonb(metric) FROM contact_metrics AS metric),
    'pipeline', (SELECT value FROM pipeline)
);
$$;

DROP FUNCTION IF EXISTS public.get_chatbot_analytics(UUID, TIMESTAMPTZ, TIMESTAMPTZ);

REVOKE ALL ON FUNCTION public.get_chatbot_activity_analytics(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_chatbot_activity_analytics(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
    TO postgres, service_role;

REVOKE ALL ON FUNCTION public.get_chatbot_contact_analytics(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_chatbot_contact_analytics(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
    TO postgres, service_role;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260922_003', 'Page-scoped chatbot performance and contact analytics')
ON CONFLICT (version) DO UPDATE SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';

COMMIT;
