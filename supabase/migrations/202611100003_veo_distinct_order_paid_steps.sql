BEGIN;
SET LOCAL lock_timeout='5s';

-- Order creation and settlement are separate milestones. Existing branch,
-- lead-stage, payment and Telegram checks continue to apply to both receipts.
ALTER FUNCTION veo_receipt_requirements(uuid,uuid,uuid,text,uuid,boolean) RENAME TO veo_receipt_requirements_before_order_steps;
CREATE FUNCTION veo_receipt_requirements(p_actor uuid,p_contact uuid,p_seller uuid,p_kind text,p_order uuid DEFAULT NULL,p_fresh boolean DEFAULT true) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE result jsonb;blocks jsonb;o veo_order_facts;
BEGIN
 result:=veo_receipt_requirements_before_order_steps(p_actor,p_contact,p_seller,p_kind,p_order,p_fresh);
 blocks:=coalesce(result->'blockers','[]');
 IF p_kind='closed' THEN
  IF p_order IS NULL THEN blocks:=blocks||'"closed_order_required"'::jsonb;
  ELSE
   SELECT * INTO o FROM veo_order_facts WHERE id=p_order;
   IF NOT EXISTS(SELECT 1 FROM veo_business_orders b WHERE b.order_id=o.id AND b.contact_id=p_contact
    AND b.page_id=o.page_id AND b.tenant_id=o.tenant_id AND NOT b.price_conflict AND b.total_minor=o.total_minor AND b.currency=o.currency) THEN
    blocks:=blocks||'"facebook_matching_order_required"'::jsonb;
   END IF;
  END IF;
 END IF;
 SELECT coalesce(jsonb_agg(DISTINCT value),'[]') INTO blocks FROM jsonb_array_elements(blocks) value;
 RETURN result||jsonb_build_object('allowed',jsonb_array_length(blocks)=0,'blockers',blocks);
END $$;
REVOKE ALL ON FUNCTION veo_receipt_requirements(uuid,uuid,uuid,text,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_receipt_requirements(uuid,uuid,uuid,text,uuid,boolean) TO service_role;

-- A new order may now have its own Closed Deal receipt before settlement.
-- Keep rejecting unrelated earlier deals, while permitting this exact link.
DO $migration$ DECLARE definition text;old_guard text;new_guard text;BEGIN
 old_guard:=$old$IF p_action='payment' AND nullif(p_data->>'closed_deal_id','') IS NOT NULL AND EXISTS(SELECT 1 FROM veo_orders WHERE id=(p_data->>'order_id')::uuid AND deal_mode='new') THEN$old$;
 new_guard:=$new$IF p_action='payment' AND nullif(p_data->>'closed_deal_id','') IS NOT NULL AND EXISTS(SELECT 1 FROM veo_orders sale_order WHERE sale_order.id=(p_data->>'order_id')::uuid AND sale_order.deal_mode='new'
 AND NOT EXISTS(SELECT 1 FROM veo_closed_deals closed_deal WHERE closed_deal.id=(p_data->>'closed_deal_id')::uuid AND closed_deal.order_id=sale_order.id
 AND (closed_deal.tenant_id,closed_deal.page_id,closed_deal.contact_id,closed_deal.seller_id,closed_deal.currency) IS NOT DISTINCT FROM (sale_order.tenant_id,sale_order.page_id,sale_order.contact_id,sale_order.seller_id,sale_order.currency))) THEN$new$;
 definition:=pg_get_functiondef('veo_action_before_receipt_gate(uuid,text,jsonb)'::regprocedure);
 IF strpos(definition,old_guard)=0 THEN RAISE EXCEPTION 'Expected independent-deal payment guard is missing';END IF;
 EXECUTE replace(definition,old_guard,new_guard);
END $migration$;
NOTIFY pgrst,'reload schema';
COMMIT;
