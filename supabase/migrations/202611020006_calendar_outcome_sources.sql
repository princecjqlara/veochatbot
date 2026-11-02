BEGIN;
SET LOCAL lock_timeout='5s';

-- Preserve the original ledger and attribution functions. This read-only layer
-- exposes already-documented conversation confirmations without inventing cash.
CREATE OR REPLACE FUNCTION public.ad_calendar_outcomes(p_page_ids UUID[],p_from TIMESTAMPTZ,p_to TIMESTAMPTZ,p_ad_id TEXT DEFAULT NULL)
RETURNS TABLE(id UUID,page_id UUID,ad_id TEXT,inquiry_at TIMESTAMPTZ,inquiry_day DATE,inquiry_basis TEXT,
 name TEXT,psid TEXT,stage TEXT,converted_at TIMESTAMPTZ,paid_at TIMESTAMPTZ,finance JSONB,pre_inquiry_payments BIGINT,
 converted BOOLEAN,order_created BOOLEAN,confirmed_at TIMESTAMPTZ,chat_confirmed BOOLEAN,
 conversation_reviewed BOOLEAN,confirmation_stale BOOLEAN,confirmation_evidence_id TEXT,confirmation_source_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET plan_cache_mode='force_custom_plan' AS $$
 WITH source AS (
  SELECT c.*,f.source_cutoff_at,
   CASE WHEN f.payment_evidence_id IS NOT NULL AND length(btrim(f.payment_evidence_id))>0
     AND f.payment_at>=greatest(c.inquiry_at,f.first_inquiry_at) AND f.payment_at<=least(f.source_cutoff_at,statement_timestamp())
    THEN f.payment_at END AS chat_at,
   f.payment_evidence_id,f.dirty_at,history.at AS previous_conversion
  FROM public.ad_calendar_cohort(p_page_ids,p_from,p_to,p_ad_id) c
  LEFT JOIN public.contact_conversion_cache f ON f.contact_id=c.id AND f.page_id=c.page_id
   AND f.complete_history AND f.source_cutoff_at<=statement_timestamp()
  LEFT JOIN LATERAL (
   SELECT min(e.at) AS at FROM (
    SELECT m.occurred_at AS at FROM public.messenger_lead_stage_events m WHERE m.page_id=c.page_id AND m.contact_id=c.id AND m.applied AND m.stage='converted'
    UNION ALL SELECT a.stage_timestamp FROM public.ad_lead_stage_events a WHERE a.page_id=c.page_id AND a.contact_id=c.id AND a.stage='converted' AND a.previous_stage IS DISTINCT FROM 'converted'
   ) e WHERE c.stage='order_created' AND e.at>=c.inquiry_at AND e.at<=statement_timestamp()
  ) history ON TRUE
 )
 SELECT s.id,s.page_id,s.ad_id,s.inquiry_at,s.inquiry_day,s.inquiry_basis,s.name,s.psid,s.stage,
  coalesce(s.converted_at,s.previous_conversion),s.paid_at,s.finance,s.pre_inquiry_payments,
  s.stage='converted' OR (s.stage='order_created' AND s.previous_conversion IS NOT NULL),
  s.stage='order_created',least(s.paid_at,s.chat_at),s.chat_at IS NOT NULL,
  s.source_cutoff_at IS NOT NULL,s.chat_at IS NOT NULL AND s.dirty_at>s.source_cutoff_at,
  CASE WHEN s.chat_at IS NOT NULL THEN s.payment_evidence_id END,s.source_cutoff_at
 FROM source s;
$$;

CREATE OR REPLACE FUNCTION public.get_ad_calendar_report(p_page_ids UUID[],p_from TIMESTAMPTZ,p_to TIMESTAMPTZ,p_ad_id TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET plan_cache_mode='force_custom_plan' AS $$
 WITH cohort AS MATERIALIZED(SELECT *,
  (converted_at AT TIME ZONE 'Asia/Manila')::date-inquiry_day AS stage_lag,
  (paid_at AT TIME ZONE 'Asia/Manila')::date-inquiry_day AS paid_lag,
  (confirmed_at AT TIME ZONE 'Asia/Manila')::date-inquiry_day AS confirmed_lag
  FROM public.ad_calendar_outcomes(p_page_ids,p_from,p_to,p_ad_id)),
 grouped AS (
  SELECT page_id,ad_id,inquiry_day AS day,count(*) AS inquiries,count(*) FILTER(WHERE inquiry_basis='legacy_recorded') AS legacy_dates,
   count(*) FILTER(WHERE converted) AS converted,count(*) FILTER(WHERE converted AND converted_at IS NULL) AS conversion_time_unknown,
   count(*) FILTER(WHERE order_created) AS orders,
   count(*) FILTER(WHERE stage_lag>0) AS converted_later,count(*) FILTER(WHERE paid_at IS NOT NULL) AS payers,count(*) FILTER(WHERE paid_lag>0) AS payers_later,
   count(*) FILTER(WHERE confirmed_at IS NOT NULL) AS confirmed_payers,count(*) FILTER(WHERE confirmed_lag>0) AS confirmed_payers_later,
   count(*) FILTER(WHERE chat_confirmed) AS chat_confirmed_payers,
   count(*) FILTER(WHERE conversation_reviewed) AS reviewed_conversations,
   count(*) FILTER(WHERE confirmation_stale) AS confirmation_stale,
   sum(pre_inquiry_payments) AS pre_inquiry_payments,
   jsonb_build_array(count(*) FILTER(WHERE stage_lag=0),count(*) FILTER(WHERE stage_lag=1),count(*) FILTER(WHERE stage_lag BETWEEN 2 AND 7),count(*) FILTER(WHERE stage_lag BETWEEN 8 AND 30),count(*) FILTER(WHERE stage_lag>30)) AS stage_lags,
   jsonb_build_array(count(*) FILTER(WHERE paid_lag=0),count(*) FILTER(WHERE paid_lag=1),count(*) FILTER(WHERE paid_lag BETWEEN 2 AND 7),count(*) FILTER(WHERE paid_lag BETWEEN 8 AND 30),count(*) FILTER(WHERE paid_lag>30)) AS paid_lags,
   jsonb_build_array(count(*) FILTER(WHERE confirmed_lag=0),count(*) FILTER(WHERE confirmed_lag=1),count(*) FILTER(WHERE confirmed_lag BETWEEN 2 AND 7),count(*) FILTER(WHERE confirmed_lag BETWEEN 8 AND 30),count(*) FILTER(WHERE confirmed_lag>30)) AS confirmed_paid_lags
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
 IF p_status NOT IN('all','converted','paid','unconverted','confirmed','orders') OR p_offset<0 OR p_offset>1000000 THEN RAISE EXCEPTION 'Invalid contact filter'; END IF;
 RETURN (WITH filtered AS MATERIALIZED(
  SELECT *,CASE WHEN paid_at IS NOT NULL AND chat_confirmed THEN 'ledger_and_conversation'
    WHEN paid_at IS NOT NULL THEN 'ledger_verified' WHEN chat_confirmed THEN 'conversation_documented' ELSE 'not_verified' END AS confirmation_basis
  FROM public.ad_calendar_outcomes(p_page_ids,p_from,p_to,p_ad_id)
  WHERE p_status='all' OR p_status='converted' AND converted OR p_status='paid' AND paid_at IS NOT NULL
   OR p_status='unconverted' AND NOT converted OR p_status='confirmed' AND confirmed_at IS NOT NULL OR p_status='orders' AND order_created
 ), limited AS(SELECT * FROM filtered ORDER BY inquiry_at,id OFFSET p_offset LIMIT 25)
 SELECT jsonb_build_object('total',(SELECT count(*) FROM filtered),'contacts',coalesce((SELECT jsonb_agg(to_jsonb(l) ORDER BY inquiry_at,id) FROM limited l),'[]'::jsonb)));
END $$;

REVOKE ALL ON FUNCTION public.ad_calendar_outcomes(UUID[],TIMESTAMPTZ,TIMESTAMPTZ,TEXT),
 public.get_ad_calendar_report(UUID[],TIMESTAMPTZ,TIMESTAMPTZ,TEXT),
 public.get_ad_calendar_contacts(UUID[],TIMESTAMPTZ,TIMESTAMPTZ,TEXT,TEXT,INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ad_calendar_outcomes(UUID[],TIMESTAMPTZ,TIMESTAMPTZ,TEXT),
 public.get_ad_calendar_report(UUID[],TIMESTAMPTZ,TIMESTAMPTZ,TEXT),
 public.get_ad_calendar_contacts(UUID[],TIMESTAMPTZ,TIMESTAMPTZ,TEXT,TEXT,INTEGER) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
