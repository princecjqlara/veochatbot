BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE IF NOT EXISTS public.ad_daily_spend(
 page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 ad_id TEXT NOT NULL CHECK(ad_id~'^[0-9]+$'),account_id TEXT NOT NULL CHECK(account_id~'^[0-9]+$'),
 spend_date DATE NOT NULL,currency TEXT NOT NULL,account_timezone TEXT NOT NULL,
 pht_aligned BOOLEAN NOT NULL,amount NUMERIC(20,6) NOT NULL CHECK(amount>=0),
 impressions BIGINT,clicks BIGINT,checked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(page_id,ad_id,spend_date,account_id)
);
CREATE INDEX IF NOT EXISTS idx_ad_daily_spend_date ON public.ad_daily_spend(page_id,spend_date);
CREATE INDEX IF NOT EXISTS idx_conversion_cache_page_payment ON public.contact_conversion_cache(page_id,payment_at) WHERE payment_at IS NOT NULL;
ALTER TABLE public.ad_daily_spend ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ad_daily_spend FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.ad_daily_spend TO service_role;

CREATE OR REPLACE FUNCTION public.get_conversion_report_inputs(p_page_ids UUID[],p_from TIMESTAMPTZ,p_to TIMESTAMPTZ,p_after UUID DEFAULT NULL,p_limit INTEGER DEFAULT 1000)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 WITH base AS MATERIALIZED(
  SELECT c.* FROM ad_lead_cohorts c
  WHERE c.page_id=ANY(p_page_ids) AND cardinality(p_page_ids)<=50 AND c.first_inquiry_at IS NOT NULL
   AND (p_from IS NULL OR c.first_inquiry_at>=p_from) AND c.first_inquiry_at<p_to AND (p_after IS NULL OR c.id>p_after)
  ORDER BY c.id LIMIT LEAST(GREATEST(p_limit,1),1000)+1
 ), chosen AS MATERIALIZED(
  SELECT c.id,c.page_id,c.ad_id,c.first_inquiry_at,c.inquiry_basis,c.pipeline_stage,
   f.first_inquiry_at AS cache_first_at,f.source_cutoff_at,f.payment_at,f.payment_evidence_id,f.complete_history,f.dirty_at,
   f.source_kind,latest.snapshot,GREATEST(ct.last_interaction_at,ct.last_inbound_at,cs.last_human_activity_at) AS last_interaction_at
  FROM base c JOIN contacts ct ON ct.id=c.id AND ct.page_id=c.page_id
  LEFT JOIN contact_conversion_cache f ON f.contact_id=c.id AND f.page_id=c.page_id
  LEFT JOIN chatbot_contact_states cs ON cs.contact_id=c.id AND cs.page_id=c.page_id
  LEFT JOIN LATERAL(SELECT s AS snapshot FROM jsonb_array_elements(COALESCE(f.snapshots,'[]')) s ORDER BY (s->>'h')::numeric DESC LIMIT 1) latest ON TRUE
 ),limited AS(SELECT * FROM chosen ORDER BY id LIMIT LEAST(GREATEST(p_limit,1),1000))
 SELECT jsonb_build_object('rows',COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM limited l),'[]'::jsonb),
 'has_more',(SELECT count(*)>LEAST(GREATEST(p_limit,1),1000) FROM chosen),'next_after',(SELECT id FROM limited ORDER BY id DESC LIMIT 1));
$$;

CREATE OR REPLACE FUNCTION public.get_conversion_period_payments(p_page_ids UUID[],p_from TIMESTAMPTZ,p_to TIMESTAMPTZ)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]'::jsonb) FROM(
  SELECT page_id,count(*) AS confirmed,avg(extract(epoch FROM(payment_at-first_inquiry_at))/3600) AS avg_hours,
   percentile_cont(.5) WITHIN GROUP(ORDER BY extract(epoch FROM(payment_at-first_inquiry_at))/3600) AS median_hours
  FROM contact_conversion_cache WHERE page_id=ANY(p_page_ids) AND cardinality(p_page_ids)<=50
   AND complete_history AND payment_evidence_id IS NOT NULL AND payment_at>=first_inquiry_at AND payment_at<=source_cutoff_at
   AND (p_from IS NULL OR payment_at>=p_from) AND payment_at<p_to GROUP BY page_id
 )r;
$$;

CREATE OR REPLACE FUNCTION public.get_conversion_refresh_candidates(p_page_ids UUID[],p_from TIMESTAMPTZ,p_to TIMESTAMPTZ,p_skip UUID[] DEFAULT '{}',p_limit INTEGER DEFAULT 8)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 WITH candidates AS MATERIALIZED(
  SELECT c.id,c.page_id,GREATEST(c.last_interaction_at,c.last_inbound_at,cs.last_human_activity_at) AS last_interaction_at FROM contacts c
  LEFT JOIN contact_conversion_cache f ON f.contact_id=c.id AND f.page_id=c.page_id
  LEFT JOIN ad_contact_sources s ON s.contact_id=c.id AND s.page_id=c.page_id
  LEFT JOIN chatbot_contact_states cs ON cs.contact_id=c.id AND cs.page_id=c.page_id
  WHERE c.page_id=ANY(p_page_ids) AND cardinality(p_page_ids)<=50 AND cardinality(p_skip)<=500 AND NOT(c.id=ANY(p_skip))
  AND f.payment_at IS NULL
  AND ((p_from IS NULL OR GREATEST(c.last_interaction_at,c.last_inbound_at,cs.last_human_activity_at)>=p_from) AND GREATEST(c.last_interaction_at,c.last_inbound_at,cs.last_human_activity_at)<p_to
    OR (p_from IS NULL OR COALESCE(s.first_inquiry_at,c.first_interaction_at)>=p_from) AND COALESCE(s.first_inquiry_at,c.first_interaction_at)<p_to
    OR f.dirty_at>=COALESCE(p_from,'1970-01-01'::timestamptz) AND f.dirty_at<p_to)
  AND (f.contact_id IS NULL OR NOT f.complete_history OR f.dirty_at>f.source_cutoff_at OR GREATEST(c.last_interaction_at,c.last_inbound_at,cs.last_human_activity_at)>f.source_cutoff_at
    OR f.first_inquiry_at>now()-interval '30 days' AND f.source_cutoff_at<now()-interval '15 minutes')
 )SELECT jsonb_build_object('pending',(SELECT count(*) FROM candidates),'contacts',COALESCE((SELECT jsonb_agg(to_jsonb(l)) FROM(
  SELECT id,page_id FROM candidates ORDER BY last_interaction_at DESC NULLS LAST,id LIMIT LEAST(GREATEST(p_limit,1),8)
 )l),'[]'::jsonb));
$$;

-- Page replies can contain payment acknowledgements. Invalidate evidence only;
-- a full history refresh still establishes the first actual confirmation.
CREATE OR REPLACE FUNCTION public.mark_conversion_source_dirty(p_page_id UUID,p_psid TEXT,p_at TIMESTAMPTZ)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 UPDATE contact_conversion_cache f SET dirty_at=GREATEST(COALESCE(f.dirty_at,p_at),p_at)
 FROM contacts c WHERE c.id=f.contact_id AND c.page_id=f.page_id AND c.page_id=p_page_id AND c.psid=p_psid
 AND f.payment_at IS NULL AND p_at>f.source_cutoff_at AND p_at<=clock_timestamp()+interval '1 minute';
$$;
REVOKE ALL ON FUNCTION public.get_conversion_report_inputs(UUID[],TIMESTAMPTZ,TIMESTAMPTZ,UUID,INTEGER),
public.get_conversion_period_payments(UUID[],TIMESTAMPTZ,TIMESTAMPTZ),
public.get_conversion_refresh_candidates(UUID[],TIMESTAMPTZ,TIMESTAMPTZ,UUID[],INTEGER),
public.mark_conversion_source_dirty(UUID,TEXT,TIMESTAMPTZ) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_conversion_report_inputs(UUID[],TIMESTAMPTZ,TIMESTAMPTZ,UUID,INTEGER),
public.get_conversion_period_payments(UUID[],TIMESTAMPTZ,TIMESTAMPTZ),
public.get_conversion_refresh_candidates(UUID[],TIMESTAMPTZ,TIMESTAMPTZ,UUID[],INTEGER),
public.mark_conversion_source_dirty(UUID,TEXT,TIMESTAMPTZ) TO service_role;
INSERT INTO app_private.schema_migrations(version,description) VALUES('20261029_001','Auditable cohort performance, first-payment summaries and daily ad spend') ON CONFLICT DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
