BEGIN;
-- Count/filter narrow rows first. The previous view self-join fetched each
-- contact twice before pagination and could time out on the larger Pages.
CREATE OR REPLACE FUNCTION public.get_ad_lead_contacts_v2(
 p_page_id UUID,p_from TIMESTAMPTZ DEFAULT NULL,p_to TIMESTAMPTZ DEFAULT now(),p_ad_id TEXT DEFAULT NULL,
 p_unknown BOOLEAN DEFAULT FALSE,p_stage TEXT DEFAULT NULL,p_bot TEXT DEFAULT 'all',p_limit INTEGER DEFAULT 25,p_offset INTEGER DEFAULT 0
) RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
WITH selected AS MATERIALIZED (
 SELECT c.id,CASE WHEN s.contact_id IS NOT NULL THEN s.first_inquiry_at ELSE c.first_interaction_at END AS first_inquiry_at
 FROM contacts c LEFT JOIN ad_contact_sources s ON s.contact_id=c.id AND s.page_id=c.page_id
 WHERE c.page_id=p_page_id
 AND (CASE WHEN s.contact_id IS NOT NULL THEN s.first_inquiry_at ELSE c.first_interaction_at END) IS NOT NULL
 AND (p_from IS NULL OR (CASE WHEN s.contact_id IS NOT NULL THEN s.first_inquiry_at ELSE c.first_interaction_at END)>=p_from)
 AND (CASE WHEN s.contact_id IS NOT NULL THEN s.first_inquiry_at ELSE c.first_interaction_at END)<p_to
 AND (NOT p_unknown OR s.origin_ad_id IS NULL) AND (p_ad_id IS NULL OR s.origin_ad_id=p_ad_id)
 AND (p_stage IS NULL OR c.pipeline_stage=p_stage)
 AND (p_bot='all' OR p_bot='on' AND c.chatbot_enabled OR p_bot='off' AND NOT c.chatbot_enabled)
), limited AS (
 SELECT * FROM selected ORDER BY first_inquiry_at DESC,id LIMIT LEAST(GREATEST(p_limit,1),100) OFFSET GREATEST(p_offset,0)
)
SELECT jsonb_build_object('total',(SELECT count(*) FROM selected),'contacts',COALESCE((
 SELECT jsonb_agg(to_jsonb(a)||jsonb_build_object('chatbot_enabled',c.chatbot_enabled) ORDER BY l.first_inquiry_at DESC,l.id)
 FROM limited l JOIN ad_lead_cohorts a ON a.id=l.id AND a.page_id=p_page_id
 JOIN contacts c ON c.id=l.id AND c.page_id=p_page_id
),'[]'::jsonb));
$$;
REVOKE ALL ON FUNCTION public.get_ad_lead_contacts_v2(UUID,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,BOOLEAN,TEXT,TEXT,INTEGER,INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_ad_lead_contacts_v2(UUID,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,BOOLEAN,TEXT,TEXT,INTEGER,INTEGER) TO service_role;
INSERT INTO app_private.schema_migrations(version,description) VALUES('20261028_001','Filter narrow ad cohort rows before contact detail joins') ON CONFLICT DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
