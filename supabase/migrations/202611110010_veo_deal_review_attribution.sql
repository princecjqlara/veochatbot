BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ DECLARE definition text;needle text;BEGIN
 definition:=pg_get_functiondef('veo_submit_deal_review(uuid,jsonb,uuid[])'::regprocedure);
 needle:=' INSERT INTO veo_deal_reviews(request_id,tenant_id,page_id,contact_id,seller_id,submitted_by,receipt_kind,currency,total_price_minor,closed_amount_minor,received_now_minor,tip_minor,occurred_at,description,invoice_reference,notes,order_id,closed_deal_id,existing_closed_payment_id,payload)';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Deal evidence submission implementation changed';END IF;
 EXECUTE replace(definition,needle,$new$
 PERFORM 1 FROM contacts WHERE id=(context->>'contact_id')::uuid FOR UPDATE;
 IF o.id IS NULL AND d.id IS NULL AND EXISTS(SELECT 1 FROM veo_client_claims WHERE contact_id=(context->>'contact_id')::uuid AND user_id IS DISTINCT FROM (context->>'seller_id')::uuid) THEN
  RAISE EXCEPTION 'Select the assigned seller for a new sale, or link their existing deal' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM veo_deal_reviews previous WHERE previous.tenant_id=(context->>'tenant_id')::uuid AND previous.contact_id=(context->>'contact_id')::uuid AND previous.seller_id=(context->>'seller_id')::uuid AND previous.receipt_kind=kind AND previous.status IN('pending','approved')
  AND 3=(SELECT count(*) FROM veo_deal_review_photos prior JOIN veo_deal_review_photos incoming ON incoming.id=ANY(p_photos) AND incoming.slot=prior.slot AND incoming.photo_sha256=prior.photo_sha256 WHERE prior.review_id=previous.id)) THEN
  RAISE EXCEPTION 'These three evidence photos were already submitted. Open the existing review instead' USING ERRCODE='23505';
 END IF;
$new$||needle);
 definition:=pg_get_functiondef('veo_review_deal(uuid,uuid,text,boolean,boolean,boolean,text)'::regprocedure);
 needle:=$old$   INSERT INTO veo_orders(request_id,tenant_id,team_id,page_id,contact_id,seller_id,description,total_minor,currency,created_by,deal_mode)$old$;
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Deal approval order implementation changed';END IF;
 EXECUTE replace(definition,needle,$new$
   IF d.id IS NULL AND EXISTS(SELECT 1 FROM veo_client_claims WHERE contact_id=r.contact_id AND user_id IS DISTINCT FROM r.seller_id) THEN
    RAISE EXCEPTION 'The assigned seller changed. Reject and resubmit with the current seller' USING ERRCODE='42501';
   END IF;
$new$||needle);
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
