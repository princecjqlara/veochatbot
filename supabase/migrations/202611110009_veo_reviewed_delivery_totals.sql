BEGIN;
SET LOCAL lock_timeout='5s';
-- A Close Deal notification describes money received at that milestone, even
-- if a later Done Deal with a tip was approved before Telegram was linked.
DO $$ DECLARE definition text;needle text:=$old$CASE WHEN r.receipt_kind='closed' THEN r.closed_amount_minor ELSE o.paid_minor END+coalesce((SELECT sum(amount_minor) FROM veo_deal_tips WHERE order_id=o.id),0)$old$;BEGIN
 definition:=pg_get_functiondef('veo_reviewed_deal_handoff(uuid)'::regprocedure);
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Reviewed deal total implementation changed';END IF;
 EXECUTE replace(definition,needle,$new$CASE WHEN r.receipt_kind='closed' THEN r.closed_amount_minor ELSE o.paid_minor+coalesce((SELECT sum(amount_minor) FROM veo_deal_tips WHERE order_id=o.id),0) END$new$);
END $$;

-- A branch waiting for Telegram setup must not starve later approved receipts.
ALTER TABLE veo_deal_reviews ADD COLUMN queue_checked_at timestamptz;
CREATE INDEX veo_deal_review_waiting_delivery ON veo_deal_reviews(queue_checked_at NULLS FIRST,reviewed_at) WHERE status='approved' AND delivery_submission IS NULL;
CREATE OR REPLACE FUNCTION veo_enqueue_approved_deal_reviews(p_limit integer DEFAULT 20) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE r record;n integer:=0;BEGIN
 IF p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid review batch';END IF;
 FOR r IN SELECT d.id FROM veo_deal_reviews d WHERE status='approved' AND delivery_submission IS NULL ORDER BY queue_checked_at NULLS FIRST,reviewed_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
  UPDATE veo_deal_reviews SET queue_checked_at=clock_timestamp() WHERE id=r.id;
  IF veo_queue_reviewed_deal(r.id) THEN n:=n+1;END IF;
 END LOOP;RETURN n;END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
