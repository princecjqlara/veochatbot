BEGIN;
SET LOCAL lock_timeout='5s';
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
  SELECT c.contact_id,c.page_id,c.first_inquiry_at FROM chosen c
 ), events AS (
  SELECT c.contact_id,c.page_id,m.occurred_at AS at FROM converted c
   JOIN public.messenger_lead_stage_events m ON m.contact_id=c.contact_id AND m.page_id=c.page_id
   WHERE m.stage='converted' AND m.occurred_at>=c.first_inquiry_at AND m.occurred_at<=statement_timestamp()
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
  FROM receipts p WHERE (CASE WHEN p.reference LIKE 'az-payment:messages%.html:%' THEN (p.occurred_at AT TIME ZONE 'Asia/Manila')::date >= (p.first_inquiry_at AT TIME ZONE 'Asia/Manila')::date ELSE p.occurred_at>=p.first_inquiry_at END) GROUP BY p.contact_id,p.page_id,p.currency
 ), money AS (
  SELECT a.contact_id,a.page_id,min(a.paid_at) AS paid_at,
   jsonb_agg(jsonb_build_object('currency',a.currency,'received_minor',a.received_minor,'refunded_minor',a.refunded_minor,'records',a.records,'paid_orders',a.paid_orders) ORDER BY a.currency) AS records
  FROM amounts a GROUP BY a.contact_id,a.page_id
 ), earlier AS (
  SELECT p.contact_id,p.page_id,count(*) AS n FROM receipts p WHERE (CASE WHEN p.reference LIKE 'az-payment:messages%.html:%' THEN (p.occurred_at AT TIME ZONE 'Asia/Manila')::date < (p.first_inquiry_at AT TIME ZONE 'Asia/Manila')::date ELSE p.occurred_at<p.first_inquiry_at END) GROUP BY p.contact_id,p.page_id
 )
 SELECT c.contact_id,c.page_id,c.ad_id,c.first_inquiry_at,(c.first_inquiry_at AT TIME ZONE 'Asia/Manila')::date,c.inquiry_basis,
  names.name,names.psid,c.pipeline_stage,conversion.at,money.paid_at,coalesce(money.records,'[]'::jsonb),coalesce(earlier.n,0)
 FROM chosen c
 LEFT JOIN conversion ON conversion.contact_id=c.contact_id AND conversion.page_id=c.page_id
 LEFT JOIN money ON money.contact_id=c.contact_id AND money.page_id=c.page_id
 LEFT JOIN earlier ON earlier.contact_id=c.contact_id AND earlier.page_id=c.page_id
 LEFT JOIN LATERAL(SELECT contact.name,contact.psid FROM public.contacts contact WHERE p_include_names AND contact.id=c.contact_id AND contact.page_id=c.page_id LIMIT 1) names ON TRUE;
END $$;

INSERT INTO app_private.schema_migrations(version,description) VALUES('202611050008','Treat date-only Azshinari deal dates as calendar-day evidence in acquisition cohorts') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;




