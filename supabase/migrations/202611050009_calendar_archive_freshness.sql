BEGIN;
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION public.get_ad_calendar_report(p_page_ids UUID[],p_from TIMESTAMPTZ,p_to TIMESTAMPTZ,p_ad_id TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET plan_cache_mode='force_custom_plan' SET jit='off' AS $$
 WITH cohort AS MATERIALIZED (
  SELECT c.*,t.customer_message_count,t.page_message_count,t.customer_messages_replied,
   t.attachment_count,t.image_count,t.complete_history AS conversation_archive_current,
   COALESCE(payments.deposit_ack_count,0) AS deposit_ack_count,
   COALESCE(payments.full_payment_ack_count,0) AS full_payment_ack_count,
   payments.first_deposit_ack_at,payments.first_full_payment_ack_at,
   EXISTS(SELECT 1 FROM public.messenger_lead_stage_events m WHERE m.page_id=c.page_id AND m.contact_id=c.id AND m.stage='not_qualified' AND m.occurred_at>c.inquiry_at)
    OR EXISTS(SELECT 1 FROM public.ad_lead_stage_events a WHERE a.page_id=c.page_id AND a.contact_id=c.id AND a.stage='not_qualified' AND a.stage_timestamp>c.inquiry_at) AS became_not_qualified
  FROM public.ad_calendar_outcomes_core(p_page_ids,p_from,p_to,p_ad_id,false) c
  LEFT JOIN public.contact_conversation_metrics t ON t.contact_id=c.id AND t.page_id=c.page_id AND t.source_cutoff_at>=c.inquiry_at
  LEFT JOIN LATERAL (
   SELECT count(*) FILTER(WHERE e->>'acknowledgment'='true' AND (COALESCE(e->>'payment_type','')='downpayment' OR (COALESCE(e->>'payment_type','') NOT IN ('downpayment','full_payment') AND (e->>'quote') ~* '\m(dp|down[[:space:]]*payment|deposit)\M')))::integer AS deposit_ack_count,
    count(*) FILTER(WHERE e->>'acknowledgment'='true' AND (COALESCE(e->>'payment_type','')='full_payment' OR (COALESCE(e->>'payment_type','') NOT IN ('downpayment','full_payment') AND (e->>'kind')='full_payment_ack')))::integer AS full_payment_ack_count,
    min((e->>'at')::timestamptz) FILTER(WHERE e->>'acknowledgment'='true' AND (COALESCE(e->>'payment_type','')='downpayment' OR (COALESCE(e->>'payment_type','') NOT IN ('downpayment','full_payment') AND (e->>'quote') ~* '\m(dp|down[[:space:]]*payment|deposit)\M'))) AS first_deposit_ack_at,
    min((e->>'at')::timestamptz) FILTER(WHERE e->>'acknowledgment'='true' AND (COALESCE(e->>'payment_type','')='full_payment' OR (COALESCE(e->>'payment_type','') NOT IN ('downpayment','full_payment') AND (e->>'kind')='full_payment_ack'))) AS first_full_payment_ack_at
   FROM public.contact_profile_snapshots s CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.payload->'conversation'->'payment_evidence','[]'::jsonb)) e
   WHERE s.contact_id=c.id AND s.page_id=c.page_id AND s.generation=(SELECT max(s2.generation) FROM public.contact_profile_snapshots s2 WHERE s2.contact_id=c.id AND s2.page_id=c.page_id)
  ) payments ON TRUE
 ), grouped AS (
  SELECT page_id,ad_id,inquiry_day AS day,
   count(*) AS inquiries,count(*) FILTER(WHERE inquiry_basis='legacy_recorded') AS legacy_dates,
   count(*) FILTER(WHERE converted) AS converted,
   count(*) FILTER(WHERE converted AND converted_at IS NULL) AS conversion_time_unknown,
   count(*) FILTER(WHERE order_created) AS orders,
   count(*) FILTER(WHERE stage='not_qualified') AS not_qualified,
   count(*) FILTER(WHERE became_not_qualified) AS became_not_qualified,
   count(*) FILTER(WHERE stage='order_created' AND converted_at IS NOT NULL) AS order_timestamps,
   count(*) FILTER(WHERE deposit_ack_count>0) AS customers_with_downpayment_ack,
   count(*) FILTER(WHERE full_payment_ack_count>0) AS customers_with_full_payment_ack,
   sum(deposit_ack_count) AS downpayment_acknowledgments,sum(full_payment_ack_count) AS full_payment_acknowledgments,
   count(*) FILTER(WHERE customer_message_count IS NOT NULL AND conversation_archive_current IS TRUE) AS conversations_with_full_archive,
   count(*) FILTER(WHERE customer_message_count IS NOT NULL) AS conversations_with_archived_history,
   count(*) FILTER(WHERE customer_message_count IS NOT NULL AND conversation_archive_current IS FALSE) AS conversations_with_stale_archive,
   sum(attachment_count) AS attachment_references,sum(image_count) AS image_references,
   sum(customer_message_count) AS customer_messages,sum(page_message_count) AS page_messages,
   sum(customer_messages_replied) AS customer_messages_replied,
   CASE WHEN sum(customer_message_count)>0
    THEN sum(customer_messages_replied)::numeric/sum(customer_message_count) END AS reply_rate,
   count(*) FILTER(WHERE stage_lag>0) AS converted_later,
   count(*) FILTER(WHERE paid_at IS NOT NULL) AS payers,count(*) FILTER(WHERE paid_lag>0) AS payers_later,
   count(*) FILTER(WHERE confirmed_at IS NOT NULL) AS confirmed_payers,
   count(*) FILTER(WHERE confirmed_lag>0) AS confirmed_payers_later,
   count(*) FILTER(WHERE chat_confirmed) AS chat_confirmed_payers,
   count(*) FILTER(WHERE conversation_reviewed) AS reviewed_conversations,
   count(*) FILTER(WHERE confirmation_stale) AS confirmation_stale,
   sum(pre_inquiry_payments) AS pre_inquiry_payments,
   jsonb_build_array(count(*) FILTER(WHERE stage_lag=0),count(*) FILTER(WHERE stage_lag=1),count(*) FILTER(WHERE stage_lag BETWEEN 2 AND 7),count(*) FILTER(WHERE stage_lag BETWEEN 8 AND 30),count(*) FILTER(WHERE stage_lag>30)) AS stage_lags,
   jsonb_build_array(count(*) FILTER(WHERE order_created AND stage_lag=0),count(*) FILTER(WHERE order_created AND stage_lag=1),count(*) FILTER(WHERE order_created AND stage_lag BETWEEN 2 AND 7),count(*) FILTER(WHERE order_created AND stage_lag BETWEEN 8 AND 30),count(*) FILTER(WHERE order_created AND stage_lag>30)) AS order_lags,
   jsonb_build_array(count(*) FILTER(WHERE deposit_ack_lag=0),count(*) FILTER(WHERE deposit_ack_lag=1),count(*) FILTER(WHERE deposit_ack_lag BETWEEN 2 AND 7),count(*) FILTER(WHERE deposit_ack_lag BETWEEN 8 AND 30),count(*) FILTER(WHERE deposit_ack_lag>30)) AS downpayment_lags,
   jsonb_build_array(count(*) FILTER(WHERE full_payment_ack_lag=0),count(*) FILTER(WHERE full_payment_ack_lag=1),count(*) FILTER(WHERE full_payment_ack_lag BETWEEN 2 AND 7),count(*) FILTER(WHERE full_payment_ack_lag BETWEEN 8 AND 30),count(*) FILTER(WHERE full_payment_ack_lag>30)) AS full_payment_lags,
   jsonb_build_array(count(*) FILTER(WHERE paid_lag=0),count(*) FILTER(WHERE paid_lag=1),count(*) FILTER(WHERE paid_lag BETWEEN 2 AND 7),count(*) FILTER(WHERE paid_lag BETWEEN 8 AND 30),count(*) FILTER(WHERE paid_lag>30)) AS paid_lags,
   jsonb_build_array(count(*) FILTER(WHERE confirmed_lag=0),count(*) FILTER(WHERE confirmed_lag=1),count(*) FILTER(WHERE confirmed_lag BETWEEN 2 AND 7),count(*) FILTER(WHERE confirmed_lag BETWEEN 8 AND 30),count(*) FILTER(WHERE confirmed_lag>30)) AS confirmed_paid_lags
  FROM (
   SELECT c.*,(converted_at AT TIME ZONE 'Asia/Manila')::date-inquiry_day AS stage_lag,
    (paid_at AT TIME ZONE 'Asia/Manila')::date-inquiry_day AS paid_lag,
    (first_deposit_ack_at AT TIME ZONE 'Asia/Manila')::date-inquiry_day AS deposit_ack_lag,
    (first_full_payment_ack_at AT TIME ZONE 'Asia/Manila')::date-inquiry_day AS full_payment_ack_lag,
    (confirmed_at AT TIME ZONE 'Asia/Manila')::date-inquiry_day AS confirmed_lag
   FROM cohort c
  ) events
  GROUP BY page_id,ad_id,inquiry_day
 ), financial AS MATERIALIZED (
  SELECT c.page_id,c.ad_id,c.inquiry_day AS day,f->>'currency' AS currency,
   sum((f->>'received_minor')::numeric) AS received_minor,sum((f->>'refunded_minor')::numeric) AS refunded_minor,
   sum((f->>'records')::bigint) AS records,sum((f->>'paid_orders')::bigint) AS paid_orders
  FROM cohort c CROSS JOIN LATERAL jsonb_array_elements(c.finance) f
  GROUP BY c.page_id,c.ad_id,c.inquiry_day,f->>'currency'
 )
 SELECT jsonb_build_object('as_of',statement_timestamp(),'groups',COALESCE((
  SELECT jsonb_agg(to_jsonb(g)||jsonb_build_object('finance',COALESCE((
   SELECT jsonb_agg(to_jsonb(f)-'page_id'-'ad_id'-'day' ORDER BY f.currency)
   FROM financial f WHERE f.page_id=g.page_id AND f.ad_id IS NOT DISTINCT FROM g.ad_id AND f.day=g.day
  ),'[]'::jsonb)) ORDER BY g.day,g.page_id,g.ad_id) FROM grouped g
 ),'[]'::jsonb));
$$;
INSERT INTO app_private.schema_migrations(version,description) VALUES('202611050009','Expose stale local conversation archive coverage in calendar report') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;

