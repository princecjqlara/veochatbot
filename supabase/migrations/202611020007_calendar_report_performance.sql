BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';

CREATE INDEX IF NOT EXISTS idx_contacts_calendar_inquiry
 ON public.contacts(page_id,first_interaction_at,id) INCLUDE(pipeline_stage);
CREATE INDEX IF NOT EXISTS idx_sources_calendar_inquiry
 ON public.ad_contact_sources(page_id,first_inquiry_at,contact_id) INCLUDE(origin_ad_id,inquiry_basis,attribution_status);

-- Metrics do not need names or PSIDs for every contact. Read those only for
-- explicitly named callers or after the contact drilldown has been paginated.
CREATE OR REPLACE FUNCTION public.ad_calendar_cohort_rows(p_page_ids UUID[],p_from TIMESTAMPTZ,p_to TIMESTAMPTZ,p_ad_id TEXT,p_include_names BOOLEAN)
RETURNS TABLE(id UUID,page_id UUID,ad_id TEXT,inquiry_at TIMESTAMPTZ,inquiry_day DATE,inquiry_basis TEXT,
 name TEXT,psid TEXT,stage TEXT,converted_at TIMESTAMPTZ,paid_at TIMESTAMPTZ,finance JSONB,pre_inquiry_payments BIGINT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET plan_cache_mode='force_custom_plan' SET jit='off' AS $$
BEGIN
 IF p_page_ids IS NULL OR cardinality(p_page_ids)>50 OR p_from IS NULL OR p_to IS NULL OR p_to<=p_from OR p_to-p_from>interval '32 days'
 OR (p_ad_id IS NOT NULL AND p_ad_id<>'unknown' AND p_ad_id !~ '^[0-9]{1,100}$') THEN RAISE EXCEPTION 'Invalid calendar scope'; END IF;
 RETURN QUERY WITH chosen AS MATERIALIZED (
  SELECT s.contact_id,s.page_id,CASE WHEN s.attribution_status='verified_inline' THEN s.origin_ad_id END AS ad_id,
   s.first_inquiry_at,s.inquiry_basis,c.pipeline_stage
  FROM public.ad_contact_sources s
  JOIN LATERAL(SELECT contact.pipeline_stage FROM public.contacts contact WHERE contact.page_id=s.page_id AND contact.id=s.contact_id LIMIT 1) c ON TRUE
  WHERE s.page_id=ANY(p_page_ids) AND s.first_inquiry_at>=p_from AND s.first_inquiry_at<least(p_to,statement_timestamp())
   AND (p_ad_id IS NULL OR p_ad_id='unknown' AND (s.attribution_status IS DISTINCT FROM 'verified_inline' OR s.origin_ad_id IS NULL)
    OR s.attribution_status='verified_inline' AND s.origin_ad_id=p_ad_id)
  UNION ALL
  SELECT c.id,c.page_id,NULL::text,c.first_interaction_at,'legacy_recorded'::text,c.pipeline_stage
  FROM public.contacts c
  WHERE (p_ad_id IS NULL OR p_ad_id='unknown') AND c.page_id=ANY(p_page_ids)
   AND c.first_interaction_at>=p_from AND c.first_interaction_at<least(p_to,statement_timestamp())
   AND NOT EXISTS(SELECT 1 FROM public.ad_contact_sources s WHERE s.contact_id=c.id AND s.page_id=c.page_id)
 ), converted AS MATERIALIZED (
  SELECT c.contact_id,c.page_id,c.first_inquiry_at FROM chosen c WHERE c.pipeline_stage='converted'
 ), events AS (
  SELECT c.contact_id,c.page_id,m.occurred_at AS at FROM converted c
   JOIN public.messenger_lead_stage_events m ON m.contact_id=c.contact_id AND m.page_id=c.page_id
   WHERE m.applied AND m.stage='converted' AND m.occurred_at>=c.first_inquiry_at AND m.occurred_at<=statement_timestamp()
  UNION ALL
  SELECT c.contact_id,c.page_id,a.stage_timestamp FROM converted c
   JOIN public.ad_lead_stage_events a ON a.contact_id=c.contact_id AND a.page_id=c.page_id
   WHERE a.stage='converted' AND a.previous_stage IS DISTINCT FROM 'converted' AND a.stage_timestamp>=c.first_inquiry_at AND a.stage_timestamp<=statement_timestamp()
 ), conversion AS (
  SELECT e.contact_id,e.page_id,min(e.at) AS at FROM events e GROUP BY e.contact_id,e.page_id
 ), receipts AS MATERIALIZED (
  SELECT p.*,c.first_inquiry_at FROM public.contact_verified_payments p
   JOIN chosen c ON c.contact_id=p.contact_id AND c.page_id=p.page_id
   WHERE p.voided_at IS NULL AND p.occurred_at<=statement_timestamp()
 ), amounts AS (
  SELECT p.contact_id,p.page_id,p.currency,
   sum(CASE WHEN p.kind<>'refund' THEN p.amount_minor ELSE 0 END) AS received_minor,
   sum(CASE WHEN p.kind='refund' THEN p.amount_minor ELSE 0 END) AS refunded_minor,
   count(*) AS records,count(DISTINCT p.purchase_id) FILTER(WHERE p.kind<>'refund') AS paid_orders,
   min(p.occurred_at) FILTER(WHERE p.kind<>'refund') AS paid_at
  FROM receipts p WHERE p.occurred_at>=p.first_inquiry_at GROUP BY p.contact_id,p.page_id,p.currency
 ), money AS (
  SELECT a.contact_id,a.page_id,min(a.paid_at) AS paid_at,
   jsonb_agg(jsonb_build_object('currency',a.currency,'received_minor',a.received_minor,'refunded_minor',a.refunded_minor,'records',a.records,'paid_orders',a.paid_orders) ORDER BY a.currency) AS records
  FROM amounts a GROUP BY a.contact_id,a.page_id
 ), earlier AS (
  SELECT p.contact_id,p.page_id,count(*) AS n FROM receipts p WHERE p.occurred_at<p.first_inquiry_at GROUP BY p.contact_id,p.page_id
 )
 SELECT c.contact_id,c.page_id,c.ad_id,c.first_inquiry_at,(c.first_inquiry_at AT TIME ZONE 'Asia/Manila')::date,c.inquiry_basis,
  names.name,names.psid,c.pipeline_stage,conversion.at,money.paid_at,coalesce(money.records,'[]'::jsonb),coalesce(earlier.n,0)
 FROM chosen c
 LEFT JOIN conversion ON conversion.contact_id=c.contact_id AND conversion.page_id=c.page_id
 LEFT JOIN money ON money.contact_id=c.contact_id AND money.page_id=c.page_id
 LEFT JOIN earlier ON earlier.contact_id=c.contact_id AND earlier.page_id=c.page_id
 LEFT JOIN LATERAL(SELECT contact.name,contact.psid FROM public.contacts contact WHERE p_include_names AND contact.id=c.contact_id AND contact.page_id=c.page_id LIMIT 1) names ON TRUE;
END $$;

CREATE OR REPLACE FUNCTION public.ad_calendar_outcomes_core(p_page_ids UUID[],p_from TIMESTAMPTZ,p_to TIMESTAMPTZ,p_ad_id TEXT,p_include_names BOOLEAN)
RETURNS TABLE(id UUID,page_id UUID,ad_id TEXT,inquiry_at TIMESTAMPTZ,inquiry_day DATE,inquiry_basis TEXT,
 name TEXT,psid TEXT,stage TEXT,converted_at TIMESTAMPTZ,paid_at TIMESTAMPTZ,finance JSONB,pre_inquiry_payments BIGINT,
 converted BOOLEAN,order_created BOOLEAN,confirmed_at TIMESTAMPTZ,chat_confirmed BOOLEAN,
 conversation_reviewed BOOLEAN,confirmation_stale BOOLEAN,confirmation_evidence_id TEXT,confirmation_source_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET plan_cache_mode='force_custom_plan' SET jit='off' AS $$
 WITH source AS (
  SELECT c.*,f.source_cutoff_at,
   CASE WHEN f.payment_evidence_id IS NOT NULL AND length(btrim(f.payment_evidence_id))>0
     AND f.payment_at>=greatest(c.inquiry_at,f.first_inquiry_at) AND f.payment_at<=least(f.source_cutoff_at,statement_timestamp())
    THEN f.payment_at END AS chat_at,
   f.payment_evidence_id,f.dirty_at,history.at AS previous_conversion
  FROM public.ad_calendar_cohort_rows(p_page_ids,p_from,p_to,p_ad_id,p_include_names) c
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

CREATE OR REPLACE FUNCTION public.ad_calendar_cohort(p_page_ids UUID[],p_from TIMESTAMPTZ,p_to TIMESTAMPTZ,p_ad_id TEXT DEFAULT NULL)
RETURNS TABLE(id UUID,page_id UUID,ad_id TEXT,inquiry_at TIMESTAMPTZ,inquiry_day DATE,inquiry_basis TEXT,
 name TEXT,psid TEXT,stage TEXT,converted_at TIMESTAMPTZ,paid_at TIMESTAMPTZ,finance JSONB,pre_inquiry_payments BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET plan_cache_mode='force_custom_plan' SET jit='off' AS $$ SELECT * FROM public.ad_calendar_cohort_rows(p_page_ids,p_from,p_to,p_ad_id,true); $$;

CREATE OR REPLACE FUNCTION public.ad_calendar_outcomes(p_page_ids UUID[],p_from TIMESTAMPTZ,p_to TIMESTAMPTZ,p_ad_id TEXT DEFAULT NULL)
RETURNS TABLE(id UUID,page_id UUID,ad_id TEXT,inquiry_at TIMESTAMPTZ,inquiry_day DATE,inquiry_basis TEXT,
 name TEXT,psid TEXT,stage TEXT,converted_at TIMESTAMPTZ,paid_at TIMESTAMPTZ,finance JSONB,pre_inquiry_payments BIGINT,
 converted BOOLEAN,order_created BOOLEAN,confirmed_at TIMESTAMPTZ,chat_confirmed BOOLEAN,
 conversation_reviewed BOOLEAN,confirmation_stale BOOLEAN,confirmation_evidence_id TEXT,confirmation_source_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET plan_cache_mode='force_custom_plan' SET jit='off' AS $$ SELECT * FROM public.ad_calendar_outcomes_core(p_page_ids,p_from,p_to,p_ad_id,true); $$;

CREATE OR REPLACE FUNCTION public.get_ad_calendar_report(p_page_ids UUID[],p_from TIMESTAMPTZ,p_to TIMESTAMPTZ,p_ad_id TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET plan_cache_mode='force_custom_plan' SET jit='off' AS $$
 WITH cohort AS MATERIALIZED(SELECT *,
  (converted_at AT TIME ZONE 'Asia/Manila')::date-inquiry_day AS stage_lag,
  (paid_at AT TIME ZONE 'Asia/Manila')::date-inquiry_day AS paid_lag,
  (confirmed_at AT TIME ZONE 'Asia/Manila')::date-inquiry_day AS confirmed_lag
  FROM public.ad_calendar_outcomes_core(p_page_ids,p_from,p_to,p_ad_id,false)),
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
 ), financial AS MATERIALIZED (
  SELECT c.page_id,c.ad_id,c.inquiry_day AS day,f->>'currency' AS currency,
   sum((f->>'received_minor')::numeric) AS received_minor,sum((f->>'refunded_minor')::numeric) AS refunded_minor,
   sum((f->>'records')::bigint) AS records,sum((f->>'paid_orders')::bigint) AS paid_orders
  FROM cohort c CROSS JOIN LATERAL jsonb_array_elements(c.finance) f GROUP BY c.page_id,c.ad_id,c.inquiry_day,f->>'currency'
 ) SELECT jsonb_build_object('as_of',statement_timestamp(),'groups',coalesce((SELECT jsonb_agg(to_jsonb(g)||jsonb_build_object('finance',coalesce((
  SELECT jsonb_agg(to_jsonb(f)-'page_id'-'ad_id'-'day' ORDER BY f.currency) FROM financial f WHERE f.page_id=g.page_id AND f.ad_id IS NOT DISTINCT FROM g.ad_id AND f.day=g.day
 ),'[]'::jsonb)) ORDER BY g.day,g.page_id,g.ad_id) FROM grouped g),'[]'::jsonb));
$$;

CREATE OR REPLACE FUNCTION public.get_ad_calendar_contacts(p_page_ids UUID[],p_from TIMESTAMPTZ,p_to TIMESTAMPTZ,p_ad_id TEXT DEFAULT NULL,p_status TEXT DEFAULT 'all',p_offset INTEGER DEFAULT 0)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET plan_cache_mode='force_custom_plan' SET jit='off' AS $$
BEGIN
 IF p_status NOT IN('all','converted','paid','unconverted','confirmed','orders') OR p_offset<0 OR p_offset>1000000 THEN RAISE EXCEPTION 'Invalid contact filter'; END IF;
 RETURN (WITH filtered AS MATERIALIZED(
  SELECT *,CASE WHEN paid_at IS NOT NULL AND chat_confirmed THEN 'ledger_and_conversation'
    WHEN paid_at IS NOT NULL THEN 'ledger_verified' WHEN chat_confirmed THEN 'conversation_documented' ELSE 'not_verified' END AS confirmation_basis
  FROM public.ad_calendar_outcomes_core(p_page_ids,p_from,p_to,p_ad_id,false)
  WHERE p_status='all' OR p_status='converted' AND converted OR p_status='paid' AND paid_at IS NOT NULL
   OR p_status='unconverted' AND NOT converted OR p_status='confirmed' AND confirmed_at IS NOT NULL OR p_status='orders' AND order_created
 ), limited AS(SELECT * FROM filtered ORDER BY inquiry_at,id OFFSET p_offset LIMIT 25)
 SELECT jsonb_build_object('total',(SELECT count(*) FROM filtered),'contacts',coalesce((SELECT jsonb_agg(to_jsonb(l)||jsonb_build_object('name',names.name,'psid',names.psid) ORDER BY l.inquiry_at,l.id) FROM limited l LEFT JOIN public.contacts names ON names.id=l.id AND names.page_id=l.page_id),'[]'::jsonb)));
END $$;

REVOKE ALL ON FUNCTION public.ad_calendar_cohort_rows(UUID[],TIMESTAMPTZ,TIMESTAMPTZ,TEXT,BOOLEAN),public.ad_calendar_outcomes_core(UUID[],TIMESTAMPTZ,TIMESTAMPTZ,TEXT,BOOLEAN) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ad_calendar_cohort_rows(UUID[],TIMESTAMPTZ,TIMESTAMPTZ,TEXT,BOOLEAN),public.ad_calendar_outcomes_core(UUID[],TIMESTAMPTZ,TIMESTAMPTZ,TEXT,BOOLEAN) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
