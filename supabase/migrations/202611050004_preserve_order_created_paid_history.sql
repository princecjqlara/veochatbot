BEGIN;
SET LOCAL lock_timeout='5s';

-- Order Created is a paid conversion in this workflow. Keep that conversion
-- in its acquisition cohort even when a later stage event changes the current
-- pipeline value to Converted, Not Qualified, or another state.
CREATE OR REPLACE FUNCTION public.ad_calendar_outcomes_core(p_page_ids UUID[],p_from TIMESTAMPTZ,p_to TIMESTAMPTZ,p_ad_id TEXT,p_include_names BOOLEAN)
RETURNS TABLE(id UUID,page_id UUID,ad_id TEXT,inquiry_at TIMESTAMPTZ,inquiry_day DATE,
 inquiry_basis TEXT,name TEXT,psid TEXT,stage TEXT,converted_at TIMESTAMPTZ,paid_at TIMESTAMPTZ,
 finance JSONB,pre_inquiry_payments BIGINT,converted BOOLEAN,order_created BOOLEAN,
 confirmed_at TIMESTAMPTZ,chat_confirmed BOOLEAN,conversation_reviewed BOOLEAN,
 confirmation_stale BOOLEAN,confirmation_evidence_id TEXT,confirmation_source_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET plan_cache_mode='force_custom_plan' SET jit='off' AS $$
 WITH source AS (
  SELECT c.*,f.source_cutoff_at,
   CASE WHEN f.payment_evidence_id IS NOT NULL AND length(btrim(f.payment_evidence_id))>0
     AND f.payment_at>=greatest(c.inquiry_at,f.first_inquiry_at)
     AND f.payment_at<=least(f.source_cutoff_at,statement_timestamp()) THEN f.payment_at END AS chat_at,
   f.payment_evidence_id,f.dirty_at,history.converted_at AS history_converted_at,history.order_created_at
  FROM public.ad_calendar_cohort_rows(p_page_ids,p_from,p_to,p_ad_id,p_include_names) c
  LEFT JOIN public.contact_conversion_cache f ON f.contact_id=c.id AND f.page_id=c.page_id
   AND f.complete_history AND f.source_cutoff_at<=statement_timestamp()
  LEFT JOIN LATERAL (
   SELECT min(e.at) FILTER(WHERE e.stage='converted') AS converted_at,
    min(e.at) FILTER(WHERE e.stage='order_created') AS order_created_at
   FROM (
    SELECT m.stage,m.occurred_at AS at FROM public.messenger_lead_stage_events m
     WHERE m.page_id=c.page_id AND m.contact_id=c.id
    UNION ALL
    SELECT a.stage,a.stage_timestamp AS at FROM public.ad_lead_stage_events a
     WHERE a.page_id=c.page_id AND a.contact_id=c.id AND a.previous_stage IS DISTINCT FROM a.stage
   ) e
   WHERE e.at>=c.inquiry_at AND e.at<=statement_timestamp()
  ) history ON TRUE
 )
 SELECT s.id,s.page_id,s.ad_id,s.inquiry_at,s.inquiry_day,s.inquiry_basis,s.name,s.psid,s.stage,
  coalesce(s.converted_at,s.history_converted_at,s.order_created_at),s.paid_at,s.finance,s.pre_inquiry_payments,
  s.stage IN ('converted','order_created') OR s.converted_at IS NOT NULL OR s.history_converted_at IS NOT NULL OR s.order_created_at IS NOT NULL,
  s.stage='order_created' OR s.order_created_at IS NOT NULL,
  least(s.paid_at,s.chat_at,s.order_created_at),s.chat_at IS NOT NULL,s.source_cutoff_at IS NOT NULL,
  s.chat_at IS NOT NULL AND s.dirty_at>s.source_cutoff_at,
  CASE WHEN s.chat_at IS NOT NULL THEN s.payment_evidence_id END,s.source_cutoff_at
 FROM source s;
$$;

INSERT INTO app_private.schema_migrations(version,description)
VALUES('202611050004','Count historical Order Created events as paid conversions after later stage changes')
ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
