BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION veo_close_deal_price(p_actor uuid,p_review uuid,p_total bigint,p_expected bigint,p_reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r veo_deal_reviews;a veo_accounts;f veo_order_facts;previous bigint;BEGIN
 PERFORM veo_deal_review_access(p_actor,p_review);
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;
 IF a.role NOT IN('manager','team_leader') THEN RAISE EXCEPTION 'Only Managers and Team Leaders can correct a Close Deal price' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM veo_deal_reviews WHERE id=p_review FOR UPDATE;
 IF r.receipt_kind<>'closed' OR r.deleted_at IS NOT NULL OR r.status NOT IN('pending','approved') THEN RAISE EXCEPTION 'Choose an active Close Deal';END IF;
 IF p_total IS NULL OR p_total NOT BETWEEN 1 AND 9000000000000 OR p_total<r.closed_amount_minor THEN RAISE EXCEPTION 'Total price must cover the Close Deal down payment';END IF;
 IF length(btrim(coalesce(p_reason,'')))<3 OR length(p_reason)>500 THEN RAISE EXCEPTION 'Enter a price correction reason of 3 to 500 characters';END IF;
 previous:=r.total_price_minor;
 IF p_expected IS DISTINCT FROM previous THEN RAISE EXCEPTION 'The price changed. Refresh this receipt before editing' USING ERRCODE='23505';END IF;
 IF r.order_id IS NOT NULL THEN
  PERFORM 1 FROM veo_orders WHERE id=r.order_id FOR UPDATE;
  SELECT * INTO f FROM veo_order_facts WHERE id=r.order_id;
  IF f.id IS NULL OR f.total_minor<>previous THEN RAISE EXCEPTION 'The linked order price changed. Refresh before editing' USING ERRCODE='23505';END IF;
  IF f.done_at IS NOT NULL OR EXISTS(SELECT 1 FROM veo_deal_reviews WHERE order_id=r.order_id AND receipt_kind='done' AND deleted_at IS NULL AND status IN('pending','approved')) THEN RAISE EXCEPTION 'Resolve the Done Deal before changing this price';END IF;
  IF f.paid_minor>0 AND p_total<=f.paid_minor THEN RAISE EXCEPTION 'The new price must exceed verified payments; settle the deal through Done Deal';END IF;
 END IF;
 IF previous=p_total THEN RETURN veo_deal_review_access(p_actor,r.id);END IF;
 UPDATE veo_orders SET total_minor=p_total WHERE id=r.order_id;
 UPDATE veo_deal_reviews SET total_price_minor=p_total WHERE id=r.id OR(order_id=r.order_id AND receipt_kind='closed' AND deleted_at IS NULL AND status IN('pending','approved'));
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value,reason) VALUES(r.tenant_id,p_actor,'close_deal_price_corrected',r.id,jsonb_build_object('total_price_minor',previous),jsonb_build_object('total_price_minor',p_total,'order_id',r.order_id,'payments_unchanged',true),btrim(p_reason));
 RETURN veo_deal_review_access(p_actor,r.id);
END $$;

DO $$ DECLARE definition text;needle text:='''can_delete'',a.role';BEGIN
 definition:=pg_get_functiondef('veo_deal_review_access(uuid,uuid)'::regprocedure);
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Deal access implementation changed';END IF;
 EXECUTE replace(definition,needle,'''can_edit_price'',a.role IN(''manager'',''team_leader'') AND r.receipt_kind=''closed'' AND r.deleted_at IS NULL AND r.status IN(''pending'',''approved''),''can_delete'',a.role');
END $$;
REVOKE ALL ON FUNCTION veo_close_deal_price(uuid,uuid,bigint,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_close_deal_price(uuid,uuid,bigint,bigint,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
