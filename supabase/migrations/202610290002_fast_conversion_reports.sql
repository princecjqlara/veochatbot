BEGIN;
SET LOCAL lock_timeout='5s';
CREATE INDEX IF NOT EXISTS idx_contacts_conversion_report ON public.contacts(page_id,id)
 INCLUDE(first_interaction_at,last_interaction_at,last_inbound_at,pipeline_stage);
CREATE INDEX IF NOT EXISTS idx_sources_conversion_report ON public.ad_contact_sources(page_id,contact_id)
 INCLUDE(first_inquiry_at,origin_ad_id,inquiry_basis);
CREATE INDEX IF NOT EXISTS idx_cache_conversion_report ON public.contact_conversion_cache(page_id,contact_id)
 INCLUDE(first_inquiry_at,source_cutoff_at,payment_at,payment_evidence_id,complete_history,dirty_at);
CREATE INDEX IF NOT EXISTS idx_states_conversion_activity ON public.chatbot_contact_states(page_id,last_human_activity_at,contact_id);
CREATE INDEX IF NOT EXISTS idx_contacts_conversion_activity ON public.contacts(page_id,last_interaction_at,id);
CREATE INDEX IF NOT EXISTS idx_contacts_conversion_first ON public.contacts(page_id,first_interaction_at,id);

CREATE OR REPLACE FUNCTION public.get_conversion_report_inputs(p_page_ids UUID[],p_from TIMESTAMPTZ,p_to TIMESTAMPTZ,p_after UUID DEFAULT NULL,p_limit INTEGER DEFAULT 1000)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public SET plan_cache_mode='force_custom_plan' AS $$
BEGIN RETURN (
 WITH keys AS MATERIALIZED(
  SELECT s.contact_id AS id,s.page_id,s.origin_ad_id AS ad_id,s.first_inquiry_at,s.inquiry_basis
  FROM ad_contact_sources s WHERE s.page_id=ANY(p_page_ids) AND cardinality(p_page_ids)<=50
   AND s.first_inquiry_at IS NOT NULL AND (p_from IS NULL OR s.first_inquiry_at>=p_from) AND s.first_inquiry_at<p_to
   AND (p_after IS NULL OR s.contact_id>p_after)
  UNION ALL
  SELECT c.id,c.page_id,NULL::text,c.first_interaction_at,'legacy_recorded'::text FROM contacts c
  WHERE c.page_id=ANY(p_page_ids) AND cardinality(p_page_ids)<=50 AND c.first_interaction_at IS NOT NULL
   AND (p_from IS NULL OR c.first_interaction_at>=p_from) AND c.first_interaction_at<p_to AND (p_after IS NULL OR c.id>p_after)
   AND NOT EXISTS(SELECT 1 FROM ad_contact_sources s WHERE s.contact_id=c.id AND s.page_id=c.page_id)
 ),base AS MATERIALIZED(
  SELECT k.*,c.pipeline_stage,GREATEST(c.last_interaction_at,c.last_inbound_at) AS contact_activity_at FROM keys k JOIN contacts c ON c.id=k.id AND c.page_id=k.page_id
  ORDER BY k.id LIMIT LEAST(GREATEST(p_limit,1),1000)+1
 ),chosen AS MATERIALIZED(
  SELECT c.*,f.first_inquiry_at AS cache_first_at,f.source_cutoff_at,f.payment_at,f.payment_evidence_id,f.complete_history,f.dirty_at,
   f.source_kind,latest.snapshot,GREATEST(c.contact_activity_at,cs.last_human_activity_at) AS last_interaction_at
  FROM base c
  LEFT JOIN LATERAL(SELECT f.* FROM contact_conversion_cache f WHERE f.contact_id=c.id AND f.page_id=c.page_id LIMIT 1) f ON TRUE
  LEFT JOIN chatbot_contact_states cs ON cs.contact_id=c.id AND cs.page_id=c.page_id
  LEFT JOIN LATERAL(SELECT s AS snapshot FROM jsonb_array_elements(COALESCE(f.snapshots,'[]')) s ORDER BY (s->>'h')::numeric DESC LIMIT 1) latest ON TRUE
 ),limited AS(SELECT * FROM chosen ORDER BY id LIMIT LEAST(GREATEST(p_limit,1),1000))
 SELECT jsonb_build_object('rows',COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM limited l),'[]'::jsonb),
 'has_more',(SELECT count(*)>LEAST(GREATEST(p_limit,1),1000) FROM chosen),'next_after',(SELECT id FROM limited ORDER BY id DESC LIMIT 1))
);END;
$$;

-- Choose activity/inquiry keys first. Do not join all historical contact heaps
-- just to discover that none has activity in today's period.
CREATE OR REPLACE FUNCTION public.get_conversion_refresh_candidates(p_page_ids UUID[],p_from TIMESTAMPTZ,p_to TIMESTAMPTZ,p_skip UUID[] DEFAULT '{}',p_limit INTEGER DEFAULT 8)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public SET plan_cache_mode='force_custom_plan' AS $$
BEGIN RETURN (
 WITH relevant AS MATERIALIZED(
  SELECT id FROM contacts WHERE page_id=ANY(p_page_ids) AND (p_from IS NULL OR last_interaction_at>=p_from) AND last_interaction_at<p_to
  UNION SELECT id FROM contacts WHERE page_id=ANY(p_page_ids) AND (p_from IS NULL OR last_inbound_at>=p_from) AND last_inbound_at<p_to
  UNION SELECT id FROM contacts WHERE page_id=ANY(p_page_ids) AND (p_from IS NULL OR first_interaction_at>=p_from) AND first_interaction_at<p_to
  UNION SELECT contact_id FROM ad_contact_sources WHERE page_id=ANY(p_page_ids) AND (p_from IS NULL OR first_inquiry_at>=p_from) AND first_inquiry_at<p_to
  UNION SELECT contact_id FROM chatbot_contact_states WHERE page_id=ANY(p_page_ids) AND (p_from IS NULL OR last_human_activity_at>=p_from) AND last_human_activity_at<p_to
  UNION SELECT contact_id FROM contact_conversion_cache WHERE page_id=ANY(p_page_ids) AND (p_from IS NULL OR dirty_at>=p_from) AND dirty_at<p_to
 ), candidates AS MATERIALIZED(
  SELECT c.id,c.page_id,GREATEST(c.last_interaction_at,c.last_inbound_at,cs.last_human_activity_at) AS last_interaction_at
  FROM relevant r JOIN contacts c ON c.id=r.id
  LEFT JOIN contact_conversion_cache f ON f.contact_id=c.id AND f.page_id=c.page_id
  LEFT JOIN chatbot_contact_states cs ON cs.contact_id=c.id AND cs.page_id=c.page_id
  WHERE c.page_id=ANY(p_page_ids) AND cardinality(p_page_ids)<=50 AND cardinality(p_skip)<=500 AND NOT(c.id=ANY(p_skip))
  AND f.payment_at IS NULL
  AND (f.contact_id IS NULL OR NOT f.complete_history OR f.dirty_at>f.source_cutoff_at OR GREATEST(c.last_interaction_at,c.last_inbound_at,cs.last_human_activity_at)>f.source_cutoff_at
    OR f.first_inquiry_at>now()-interval '30 days' AND f.source_cutoff_at<now()-interval '15 minutes')
 )SELECT jsonb_build_object('pending',(SELECT count(*) FROM candidates),'contacts',COALESCE((SELECT jsonb_agg(to_jsonb(l)) FROM(
  SELECT id,page_id FROM candidates ORDER BY last_interaction_at DESC NULLS LAST,id LIMIT LEAST(GREATEST(p_limit,1),8)
 )l),'[]'::jsonb))
);END;
$$;
INSERT INTO app_private.schema_migrations(version,description) VALUES('20261029_002','Filter conversion-report keys before history joins and avoid large contact heaps') ON CONFLICT DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
