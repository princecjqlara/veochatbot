BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';

ALTER TABLE public.ad_daily_spend
 ADD COLUMN IF NOT EXISTS reach BIGINT,
 ADD COLUMN IF NOT EXISTS link_clicks BIGINT,
 ADD COLUMN IF NOT EXISTS messaging_started NUMERIC(20,6),
 ADD COLUMN IF NOT EXISTS video_plays NUMERIC(20,6),
 ADD COLUMN IF NOT EXISTS video_thruplays NUMERIC(20,6),
 ADD COLUMN IF NOT EXISTS video_complete NUMERIC(20,6),
 ADD COLUMN IF NOT EXISTS action_report_time TEXT,
 ADD COLUMN IF NOT EXISTS attribution_setting TEXT,
 ADD COLUMN IF NOT EXISTS report_complete BOOLEAN NOT NULL DEFAULT FALSE,
 ADD COLUMN IF NOT EXISTS reported_zero BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_calendar_meta_converted ON public.messenger_lead_stage_events(page_id,contact_id,occurred_at) WHERE applied AND stage='converted';
CREATE INDEX IF NOT EXISTS idx_calendar_crm_converted ON public.ad_lead_stage_events(page_id,contact_id,stage_timestamp) WHERE stage='converted';

-- Inquiry dates select the cohort. Outcomes and receipts are deliberately NOT
-- restricted to the inquiry month, so later conversions update their original day.
CREATE OR REPLACE FUNCTION public.ad_calendar_cohort(p_page_ids UUID[],p_from TIMESTAMPTZ,p_to TIMESTAMPTZ,p_ad_id TEXT DEFAULT NULL)
RETURNS TABLE(id UUID,page_id UUID,ad_id TEXT,inquiry_at TIMESTAMPTZ,inquiry_day DATE,inquiry_basis TEXT,
 name TEXT,psid TEXT,stage TEXT,converted_at TIMESTAMPTZ,paid_at TIMESTAMPTZ,finance JSONB,pre_inquiry_payments BIGINT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET plan_cache_mode='force_custom_plan' AS $$
BEGIN
 IF p_page_ids IS NULL OR cardinality(p_page_ids)>50 OR p_from IS NULL OR p_to IS NULL OR p_to<=p_from OR p_to-p_from>interval '32 days'
 OR (p_ad_id IS NOT NULL AND p_ad_id<>'unknown' AND p_ad_id !~ '^[0-9]{1,100}$') THEN RAISE EXCEPTION 'Invalid calendar scope'; END IF;
 RETURN QUERY WITH keys AS MATERIALIZED (
  SELECT s.contact_id,s.page_id,CASE WHEN s.attribution_status='verified_inline' THEN s.origin_ad_id END AS ad_id,s.first_inquiry_at,s.inquiry_basis
  FROM public.ad_contact_sources s WHERE s.page_id=ANY(p_page_ids) AND s.first_inquiry_at>=p_from AND s.first_inquiry_at<least(p_to,statement_timestamp())
  UNION ALL
  SELECT c.id,c.page_id,NULL::text,c.first_interaction_at,'legacy_recorded'::text FROM public.contacts c
  WHERE c.page_id=ANY(p_page_ids) AND c.first_interaction_at>=p_from AND c.first_interaction_at<least(p_to,statement_timestamp())
  AND NOT EXISTS(SELECT 1 FROM public.ad_contact_sources s WHERE s.contact_id=c.id AND s.page_id=c.page_id)
 ), chosen AS MATERIALIZED (
  SELECT k.*,c.name,c.psid,c.pipeline_stage FROM keys k JOIN public.contacts c ON c.id=k.contact_id AND c.page_id=k.page_id
  WHERE p_ad_id IS NULL OR (p_ad_id='unknown' AND k.ad_id IS NULL) OR k.ad_id=p_ad_id
 ) SELECT c.contact_id,c.page_id,c.ad_id,c.first_inquiry_at,(c.first_inquiry_at AT TIME ZONE 'Asia/Manila')::date,c.inquiry_basis,
 c.name,c.psid,c.pipeline_stage,conversion.at,payment.at,coalesce(money.records,'[]'::jsonb),coalesce(earlier.n,0)
 FROM chosen c
 LEFT JOIN LATERAL (
  SELECT min(e.at) AS at FROM (
   SELECT m.occurred_at AS at FROM public.messenger_lead_stage_events m WHERE m.page_id=c.page_id AND m.contact_id=c.contact_id AND m.applied AND m.stage='converted'
   UNION ALL SELECT a.stage_timestamp FROM public.ad_lead_stage_events a WHERE a.page_id=c.page_id AND a.contact_id=c.contact_id AND a.stage='converted' AND a.previous_stage IS DISTINCT FROM 'converted'
  ) e WHERE c.pipeline_stage='converted' AND e.at>=c.first_inquiry_at AND e.at<=statement_timestamp()
 ) conversion ON TRUE
 LEFT JOIN LATERAL (
  SELECT min(p.occurred_at) AS at FROM public.contact_verified_payments p WHERE p.page_id=c.page_id AND p.contact_id=c.contact_id AND p.voided_at IS NULL
  AND p.kind<>'refund' AND p.occurred_at>=c.first_inquiry_at AND p.occurred_at<=statement_timestamp()
 ) payment ON TRUE
 LEFT JOIN LATERAL (
  SELECT jsonb_agg(to_jsonb(g) ORDER BY g.currency) AS records FROM (
   SELECT p.currency,sum(CASE WHEN p.kind<>'refund' THEN p.amount_minor ELSE 0 END) AS received_minor,
    sum(CASE WHEN p.kind='refund' THEN p.amount_minor ELSE 0 END) AS refunded_minor,count(*) AS records,
    count(DISTINCT p.purchase_id) FILTER(WHERE p.kind<>'refund') AS paid_orders
   FROM public.contact_verified_payments p WHERE p.page_id=c.page_id AND p.contact_id=c.contact_id AND p.voided_at IS NULL
    AND p.occurred_at>=c.first_inquiry_at AND p.occurred_at<=statement_timestamp() GROUP BY p.currency
  ) g
 ) money ON TRUE
 LEFT JOIN LATERAL (
  SELECT count(*) AS n FROM public.contact_verified_payments p WHERE p.page_id=c.page_id AND p.contact_id=c.contact_id AND p.voided_at IS NULL AND p.occurred_at<c.first_inquiry_at
 ) earlier ON TRUE;
END $$;

CREATE OR REPLACE FUNCTION public.get_ad_calendar_report(p_page_ids UUID[],p_from TIMESTAMPTZ,p_to TIMESTAMPTZ,p_ad_id TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET plan_cache_mode='force_custom_plan' AS $$
 WITH cohort AS MATERIALIZED(SELECT *,
  (converted_at AT TIME ZONE 'Asia/Manila')::date-inquiry_day AS stage_lag,
  (paid_at AT TIME ZONE 'Asia/Manila')::date-inquiry_day AS paid_lag
  FROM public.ad_calendar_cohort(p_page_ids,p_from,p_to,p_ad_id)),
 grouped AS (
  SELECT page_id,ad_id,inquiry_day AS day,count(*) AS inquiries,count(*) FILTER(WHERE inquiry_basis='legacy_recorded') AS legacy_dates,
   count(*) FILTER(WHERE stage='converted') AS converted,count(*) FILTER(WHERE stage='converted' AND converted_at IS NULL) AS conversion_time_unknown,
   count(*) FILTER(WHERE stage_lag>0) AS converted_later,count(*) FILTER(WHERE paid_at IS NOT NULL) AS payers,count(*) FILTER(WHERE paid_lag>0) AS payers_later,
   sum(pre_inquiry_payments) AS pre_inquiry_payments,
   jsonb_build_array(count(*) FILTER(WHERE stage_lag=0),count(*) FILTER(WHERE stage_lag=1),count(*) FILTER(WHERE stage_lag BETWEEN 2 AND 7),count(*) FILTER(WHERE stage_lag BETWEEN 8 AND 30),count(*) FILTER(WHERE stage_lag>30)) AS stage_lags,
   jsonb_build_array(count(*) FILTER(WHERE paid_lag=0),count(*) FILTER(WHERE paid_lag=1),count(*) FILTER(WHERE paid_lag BETWEEN 2 AND 7),count(*) FILTER(WHERE paid_lag BETWEEN 8 AND 30),count(*) FILTER(WHERE paid_lag>30)) AS paid_lags
  FROM cohort GROUP BY page_id,ad_id,inquiry_day
 ), financial AS (
  SELECT c.page_id,c.ad_id,c.inquiry_day AS day,f->>'currency' AS currency,
   sum((f->>'received_minor')::numeric) AS received_minor,sum((f->>'refunded_minor')::numeric) AS refunded_minor,
   sum((f->>'records')::bigint) AS records,sum((f->>'paid_orders')::bigint) AS paid_orders
  FROM cohort c CROSS JOIN LATERAL jsonb_array_elements(c.finance) f GROUP BY c.page_id,c.ad_id,c.inquiry_day,f->>'currency'
 ) SELECT jsonb_build_object('as_of',statement_timestamp(),'groups',coalesce((SELECT jsonb_agg(to_jsonb(g)||jsonb_build_object('finance',coalesce((
  SELECT jsonb_agg(to_jsonb(f)-'page_id'-'ad_id'-'day' ORDER BY f.currency) FROM financial f WHERE f.page_id=g.page_id AND f.ad_id IS NOT DISTINCT FROM g.ad_id AND f.day=g.day
 ),'[]'::jsonb)) ORDER BY g.day,g.page_id,g.ad_id) FROM grouped g),'[]'::jsonb));
$$;

CREATE OR REPLACE FUNCTION public.get_ad_calendar_contacts(p_page_ids UUID[],p_from TIMESTAMPTZ,p_to TIMESTAMPTZ,p_ad_id TEXT DEFAULT NULL,p_status TEXT DEFAULT 'all',p_offset INTEGER DEFAULT 0)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET plan_cache_mode='force_custom_plan' AS $$
BEGIN
 IF p_status NOT IN('all','converted','paid','unconverted') OR p_offset<0 OR p_offset>1000000 THEN RAISE EXCEPTION 'Invalid contact filter'; END IF;
 RETURN (WITH filtered AS MATERIALIZED(
  SELECT * FROM public.ad_calendar_cohort(p_page_ids,p_from,p_to,p_ad_id)
  WHERE (p_ad_id IS NOT NULL OR ad_id IS NOT NULL) AND (p_status='all' OR p_status='converted' AND stage='converted' OR p_status='paid' AND paid_at IS NOT NULL OR p_status='unconverted' AND stage IS DISTINCT FROM 'converted')
 ), limited AS(SELECT * FROM filtered ORDER BY inquiry_at,id OFFSET p_offset LIMIT 25)
 SELECT jsonb_build_object('total',(SELECT count(*) FROM filtered),'contacts',coalesce((SELECT jsonb_agg(to_jsonb(l) ORDER BY inquiry_at,id) FROM limited l),'[]'::jsonb)));
END $$;

REVOKE ALL ON FUNCTION public.ad_calendar_cohort(UUID[],TIMESTAMPTZ,TIMESTAMPTZ,TEXT),public.get_ad_calendar_report(UUID[],TIMESTAMPTZ,TIMESTAMPTZ,TEXT),public.get_ad_calendar_contacts(UUID[],TIMESTAMPTZ,TIMESTAMPTZ,TEXT,TEXT,INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ad_calendar_cohort(UUID[],TIMESTAMPTZ,TIMESTAMPTZ,TEXT),public.get_ad_calendar_report(UUID[],TIMESTAMPTZ,TIMESTAMPTZ,TEXT),public.get_ad_calendar_contacts(UUID[],TIMESTAMPTZ,TIMESTAMPTZ,TEXT,TEXT,INTEGER) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
