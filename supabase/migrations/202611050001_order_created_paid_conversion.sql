BEGIN;
SET LOCAL lock_timeout='5s';

-- In this Veo workflow, Meta's Order Created stage is the paid conversion.
-- Keep its monetary value separate: the stage proves an order outcome but
-- does not supply a verified receipt amount.
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
   f.payment_evidence_id,f.dirty_at,history.at AS outcome_at
  FROM public.ad_calendar_cohort_rows(p_page_ids,p_from,p_to,p_ad_id,p_include_names) c
  LEFT JOIN public.contact_conversion_cache f ON f.contact_id=c.id AND f.page_id=c.page_id
   AND f.complete_history AND f.source_cutoff_at<=statement_timestamp()
  LEFT JOIN LATERAL (
   SELECT min(e.at) AS at FROM (
    SELECT m.stage,m.occurred_at AS at FROM public.messenger_lead_stage_events m
     WHERE m.page_id=c.page_id AND m.contact_id=c.id
    UNION ALL
    SELECT a.stage,a.stage_timestamp FROM public.ad_lead_stage_events a
     WHERE a.page_id=c.page_id AND a.contact_id=c.id AND a.previous_stage IS DISTINCT FROM a.stage
   ) e WHERE c.stage IN ('converted','order_created') AND e.stage=c.stage
     AND e.at>=c.inquiry_at AND e.at<=statement_timestamp()
  ) history ON TRUE
 )
 SELECT s.id,s.page_id,s.ad_id,s.inquiry_at,s.inquiry_day,s.inquiry_basis,s.name,s.psid,s.stage,
  coalesce(s.converted_at,s.outcome_at),s.paid_at,s.finance,s.pre_inquiry_payments,
  s.stage IN ('converted','order_created'),s.stage='order_created',
  least(s.paid_at,s.chat_at,CASE WHEN s.stage='order_created' THEN s.outcome_at END),
  s.chat_at IS NOT NULL,s.source_cutoff_at IS NOT NULL,
  s.chat_at IS NOT NULL AND s.dirty_at>s.source_cutoff_at,
  CASE WHEN s.chat_at IS NOT NULL THEN s.payment_evidence_id END,s.source_cutoff_at
 FROM source s;
$$;

CREATE OR REPLACE FUNCTION public.get_ad_calendar_contacts(p_page_ids UUID[],p_from TIMESTAMPTZ,p_to TIMESTAMPTZ,p_ad_id TEXT DEFAULT NULL,p_status TEXT DEFAULT 'all',p_offset INTEGER DEFAULT 0)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET plan_cache_mode='force_custom_plan' SET jit='off' AS $$
BEGIN
 IF p_status NOT IN('all','converted','paid','unconverted','confirmed','orders') OR p_offset<0 OR p_offset>1000000 THEN RAISE EXCEPTION 'Invalid contact filter'; END IF;
 RETURN (WITH filtered AS MATERIALIZED(
  SELECT *,CASE WHEN paid_at IS NOT NULL AND chat_confirmed THEN 'ledger_and_conversation'
    WHEN paid_at IS NOT NULL THEN 'ledger_verified' WHEN chat_confirmed THEN 'conversation_documented'
    WHEN order_created THEN 'order_created_means_paid' ELSE 'not_verified' END AS confirmation_basis
  FROM public.ad_calendar_outcomes_core(p_page_ids,p_from,p_to,p_ad_id,false)
  WHERE p_status='all' OR p_status='converted' AND converted
   OR p_status='paid' AND (paid_at IS NOT NULL OR order_created)
   OR p_status='unconverted' AND NOT converted OR p_status='confirmed' AND confirmed_at IS NOT NULL
   OR p_status='orders' AND order_created
 ), limited AS(SELECT * FROM filtered ORDER BY inquiry_at,id OFFSET p_offset LIMIT 25)
 SELECT jsonb_build_object('total',(SELECT count(*) FROM filtered),
  'contacts',coalesce((SELECT jsonb_agg(to_jsonb(l)||jsonb_build_object('name',names.name,'psid',names.psid)
   ORDER BY l.inquiry_at,l.id) FROM limited l LEFT JOIN public.contacts names ON names.id=l.id AND names.page_id=l.page_id),'[]'::jsonb)));
END $$;

INSERT INTO app_private.schema_migrations(version,description)
VALUES('20261105_001','Count Order Created as paid conversion while keeping receipt amounts independently verified')
ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
