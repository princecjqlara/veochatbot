BEGIN;
SET LOCAL lock_timeout='5s';
-- Messenger history exposes second precision; webhook timestamps include ms.
-- The same provider message is the same inquiry even when its time is refined.
CREATE OR REPLACE FUNCTION public.save_contact_conversion_cache(p_page_id UUID,p_contact_id UUID,p_payload JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_cut TIMESTAMPTZ:=(p_payload->>'source_cutoff_at')::timestamptz;
 v_first TIMESTAMPTZ:=(p_payload->>'first_inquiry_at')::timestamptz;
 v_payment TIMESTAMPTZ:=(p_payload->>'payment_at')::timestamptz;
 v_row contact_conversion_cache%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM contacts WHERE id=p_contact_id AND page_id=p_page_id) THEN RAISE EXCEPTION 'Contact outside Page'; END IF;
 IF v_first IS NULL OR v_cut IS NULL OR v_first>v_cut OR v_cut>clock_timestamp()+interval '1 minute'
 OR jsonb_typeof(p_payload->'snapshots')<>'array' OR jsonb_array_length(p_payload->'snapshots')>7
 OR v_payment IS NOT NULL AND (v_payment<v_first OR v_payment>v_cut OR NULLIF(p_payload->>'payment_evidence_id','') IS NULL)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'snapshots') f WHERE (f->>'h')::numeric NOT IN(0,1,6,24,72,168,336)
   OR v_first+((f->>'h')::numeric*interval '1 hour')>v_cut) THEN RAISE EXCEPTION 'Invalid verified prediction source'; END IF;
 INSERT INTO contact_conversion_cache AS old(contact_id,page_id,first_inquiry_at,first_message_id,source_cutoff_at,snapshots,payment_at,payment_evidence_id,source_kind,complete_history,dirty_at)
 VALUES(p_contact_id,p_page_id,v_first,p_payload->>'first_message_id',v_cut,p_payload->'snapshots',v_payment,p_payload->>'payment_evidence_id','live_graph',TRUE,
   CASE WHEN (SELECT last_inbound_at FROM contacts WHERE id=p_contact_id)>v_cut THEN clock_timestamp() END)
 ON CONFLICT(contact_id) DO UPDATE SET first_inquiry_at=EXCLUDED.first_inquiry_at,first_message_id=EXCLUDED.first_message_id,source_cutoff_at=EXCLUDED.source_cutoff_at,snapshots=EXCLUDED.snapshots,
 payment_at=EXCLUDED.payment_at,payment_evidence_id=EXCLUDED.payment_evidence_id,source_kind=EXCLUDED.source_kind,complete_history=TRUE,
 dirty_at=CASE WHEN old.dirty_at>EXCLUDED.source_cutoff_at THEN old.dirty_at ELSE EXCLUDED.dirty_at END,updated_at=clock_timestamp()
 WHERE old.page_id=p_page_id AND old.source_cutoff_at<=EXCLUDED.source_cutoff_at;
 -- A stale concurrent source must not change either the cache or its origin.
 SELECT * INTO v_row FROM contact_conversion_cache WHERE contact_id=p_contact_id AND page_id=p_page_id;
 IF v_row.source_cutoff_at>v_cut THEN RETURN to_jsonb(v_row); END IF;
 IF NULLIF(p_payload->>'first_message_id','') IS NOT NULL THEN
  INSERT INTO ad_contact_sources AS s(contact_id,page_id,first_inquiry_at,first_message_id,inquiry_basis)
  VALUES(p_contact_id,p_page_id,v_first,p_payload->>'first_message_id','verified_history')
  ON CONFLICT(contact_id) DO UPDATE SET first_inquiry_at=EXCLUDED.first_inquiry_at,first_message_id=EXCLUDED.first_message_id,inquiry_basis='verified_history',
   origin_ad_id=CASE WHEN s.first_message_id IS DISTINCT FROM EXCLUDED.first_message_id THEN NULL ELSE s.origin_ad_id END,
   origin_evidence_key=CASE WHEN s.first_message_id IS DISTINCT FROM EXCLUDED.first_message_id THEN NULL ELSE s.origin_evidence_key END,
   attribution_status=CASE WHEN s.first_message_id IS DISTINCT FROM EXCLUDED.first_message_id THEN 'unknown' ELSE s.attribution_status END,updated_at=clock_timestamp()
  WHERE s.first_inquiry_at IS NULL OR s.inquiry_basis='legacy_recorded'
    OR EXCLUDED.first_inquiry_at<s.first_inquiry_at AND (
       s.first_message_id IS NOT DISTINCT FROM EXCLUDED.first_message_id OR s.first_message_id IS NULL
       OR date_trunc('second',EXCLUDED.first_inquiry_at)<date_trunc('second',s.first_inquiry_at));
 END IF;
 RETURN to_jsonb(v_row);
END $$;
REVOKE ALL ON FUNCTION public.save_contact_conversion_cache(UUID,UUID,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_contact_conversion_cache(UUID,UUID,JSONB) TO service_role;

-- Restore only a unique actual ad referral attached to the identical first
-- customer message, independently confirmed by a complete history read.
WITH evidence AS (
 SELECT s.contact_id,min(r.ad_id) AS ad_id,min(r.event_key) AS evidence_key
 FROM ad_contact_sources s JOIN contact_conversion_cache f ON f.contact_id=s.contact_id AND f.page_id=s.page_id
 JOIN ad_referral_events r ON r.contact_id=s.contact_id AND r.page_id=s.page_id AND r.message_id=s.first_message_id
 WHERE s.origin_ad_id IS NULL AND s.attribution_status='unknown' AND s.first_message_id IS NOT NULL
 AND f.complete_history AND f.source_kind='live_graph' AND f.first_message_id=s.first_message_id AND f.first_inquiry_at=s.first_inquiry_at
 AND r.ad_id IS NOT NULL AND r.event_kind IN('message','postback')
 GROUP BY s.contact_id HAVING count(DISTINCT r.ad_id)=1
)
UPDATE ad_contact_sources s SET origin_ad_id=e.ad_id,origin_evidence_key=e.evidence_key,attribution_status='verified_inline',updated_at=clock_timestamp()
FROM evidence e WHERE e.contact_id=s.contact_id;
INSERT INTO app_private.schema_migrations(version,description) VALUES('20261028_003','Preserve identical first-message ad evidence across timestamp precision and repair proven links') ON CONFLICT DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
