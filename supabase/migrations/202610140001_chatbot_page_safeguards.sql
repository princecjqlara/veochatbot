-- Preserve the start of a paginated scan so edits made during it are revisited.
ALTER TABLE public.pages ADD COLUMN IF NOT EXISTS messaging_auto_tag_scan_started_at TIMESTAMPTZ;

-- Bounded, idempotent recovery of outcome tags after a transient tag write failure.
-- The saved pipeline is the authority; this function never changes stages or sends messages.
CREATE OR REPLACE FUNCTION public.repair_chatbot_page_outcome_tags(p_page_id UUID, p_limit INTEGER DEFAULT 250)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE added INTEGER;
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
        RAISE EXCEPTION 'p_limit must be between 1 and 1000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.chatbot_configs WHERE page_id=p_page_id AND enabled) THEN
        RETURN 0;
    END IF;
    WITH missing AS (
        SELECT c.id AS contact_id,t.id AS tag_id
        FROM public.contacts c JOIN public.tags t
          ON t.owner_type='page' AND t.owner_id=c.page_id AND t.system_key=c.pipeline_stage
        WHERE c.page_id=p_page_id AND c.pipeline_stage_source='messenger'
          AND c.pipeline_stage IN ('qualified','not_qualified','converted','order_created')
          AND NOT EXISTS (SELECT 1 FROM public.contact_tags ct WHERE ct.contact_id=c.id AND ct.tag_id=t.id)
        ORDER BY c.id LIMIT p_limit FOR UPDATE OF c SKIP LOCKED
    ), inserted AS (
        INSERT INTO public.contact_tags(contact_id,tag_id)
        SELECT contact_id,tag_id FROM missing ON CONFLICT(contact_id,tag_id) DO NOTHING RETURNING 1
    ) SELECT COUNT(*)::INTEGER INTO added FROM inserted;
    RETURN added;
END;
$$;
REVOKE ALL ON FUNCTION public.repair_chatbot_page_outcome_tags(UUID,INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.repair_chatbot_page_outcome_tags(UUID,INTEGER) TO service_role;

INSERT INTO app_private.schema_migrations(version,description)
VALUES('20261014_001','Retry saved Messenger outcome tags and preserve paginated scan boundaries')
ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst, 'reload schema';
