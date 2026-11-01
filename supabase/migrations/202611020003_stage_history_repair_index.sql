BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';

-- Imported contacts with no stage decision must not dominate each Page repair.
CREATE INDEX IF NOT EXISTS idx_contacts_page_stage_history_repair
    ON public.contacts(page_id,id) WHERE pipeline_stage_source<>'system';

CREATE OR REPLACE FUNCTION public.stage_history_tag_key(p_label TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog AS $$
    SELECT 'stage_history:' || CASE WHEN normalized IN
        ('new','engaged','collecting_details','qualified','not_qualified','converted','order_created','opted_out','intake','contacted','interested')
        THEN normalized ELSE 'custom:'||md5(lower(btrim(p_label))) END
    FROM (SELECT regexp_replace(lower(btrim(p_label)),'[[:space:]-]+','_','g') AS normalized) value;
$$;

CREATE OR REPLACE FUNCTION public.repair_chatbot_page_outcome_tags(p_page_id UUID,p_limit INTEGER DEFAULT 250)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE row RECORD; added INTEGER=0;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Invalid repair limit'; END IF;
    FOR row IN
        SELECT c.id,c.pipeline_stage,CASE WHEN c.pipeline_stage_source='messenger' AND c.messenger_stage_label IS NOT NULL
            THEN c.messenger_stage_label ELSE initcap(replace(c.pipeline_stage,'_',' ')) END AS label
        FROM public.contacts c
        LEFT JOIN public.tags t ON t.owner_type='page' AND t.owner_id=p_page_id
            AND t.system_key=public.stage_history_tag_key(CASE WHEN c.pipeline_stage_source='messenger' AND c.messenger_stage_label IS NOT NULL
                THEN c.messenger_stage_label ELSE initcap(replace(c.pipeline_stage,'_',' ')) END)
        LEFT JOIN public.contact_tags ct ON ct.contact_id=c.id AND ct.tag_id=t.id
        WHERE c.page_id=p_page_id AND c.pipeline_stage_source<>'system' AND ct.contact_id IS NULL
        ORDER BY c.id LIMIT p_limit FOR UPDATE OF c SKIP LOCKED
    LOOP
        PERFORM public.add_contact_stage_history_tag(p_page_id,row.id,row.label,row.pipeline_stage); added=added+1;
    END LOOP;
    RETURN added;
END; $$;

REVOKE ALL ON FUNCTION public.stage_history_tag_key(TEXT),public.repair_chatbot_page_outcome_tags(UUID,INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.stage_history_tag_key(TEXT),public.repair_chatbot_page_outcome_tags(UUID,INTEGER) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
