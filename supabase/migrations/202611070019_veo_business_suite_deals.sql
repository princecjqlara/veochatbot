BEGIN;
DROP INDEX veo_closed_deal_unlinked;
CREATE INDEX veo_closed_deal_open ON veo_closed_deals(tenant_id,contact_id,seller_id) WHERE order_id IS NULL;
ALTER TABLE veo_orders ADD COLUMN deal_mode text NOT NULL DEFAULT 'existing' CHECK(deal_mode IN('new','existing'));
CREATE TABLE veo_business_orders(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES veo_tenants(id),page_id uuid NOT NULL REFERENCES pages(id),contact_id uuid NOT NULL REFERENCES contacts(id),
 invoice_id text NOT NULL CHECK(invoice_id~'^[0-9]{1,80}$'),message_id text NOT NULL,total_minor bigint NOT NULL CHECK(total_minor>0 AND total_minor<=1000000000000),currency text NOT NULL CHECK(currency='PHP'),
 occurred_at timestamptz NOT NULL,observed_at timestamptz NOT NULL DEFAULT now(),order_id uuid UNIQUE REFERENCES veo_orders(id),price_conflict boolean NOT NULL DEFAULT false,
 UNIQUE(page_id,invoice_id)
);
ALTER TABLE veo_business_orders ENABLE ROW LEVEL SECURITY;REVOKE ALL ON veo_business_orders FROM PUBLIC,anon,authenticated;GRANT ALL ON veo_business_orders TO service_role;

CREATE FUNCTION veo_observe_business_orders(p_actor uuid,p_contact uuid,p_orders jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a veo_accounts;c contacts;x jsonb;old veo_business_orders;BEGIN
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;SELECT * INTO c FROM contacts WHERE id=p_contact;
 IF a.user_id IS NULL OR c.id IS NULL OR NOT veo_can_page(p_actor,c.page_id) THEN RAISE EXCEPTION 'Page access denied' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(p_orders)<>'array' OR jsonb_array_length(p_orders)>500 THEN RAISE EXCEPTION 'Invalid order observations';END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(p_orders) LOOP
  IF(x->>'occurred_at')::timestamptz<(SELECT launch_at FROM veo_tenants WHERE id=a.tenant_id) OR(x->>'occurred_at')::timestamptz>now() THEN RAISE EXCEPTION 'Order outside launch period';END IF;
  SELECT * INTO old FROM veo_business_orders WHERE page_id=c.page_id AND invoice_id=x->>'invoice_id' FOR UPDATE;
  IF old.id IS NOT NULL AND old.contact_id<>c.id THEN RAISE EXCEPTION 'Invoice already belongs to another client';END IF;
  INSERT INTO veo_business_orders(tenant_id,page_id,contact_id,invoice_id,message_id,total_minor,currency,occurred_at)
  VALUES(a.tenant_id,c.page_id,c.id,x->>'invoice_id',x->>'message_id',(x->>'total_minor')::bigint,x->>'currency',(x->>'occurred_at')::timestamptz)
  ON CONFLICT(page_id,invoice_id) DO UPDATE SET observed_at=clock_timestamp(),message_id=EXCLUDED.message_id,
   price_conflict=veo_business_orders.order_id IS NOT NULL AND(veo_business_orders.total_minor<>EXCLUDED.total_minor OR veo_business_orders.currency<>EXCLUDED.currency),
   total_minor=CASE WHEN veo_business_orders.order_id IS NULL THEN EXCLUDED.total_minor ELSE veo_business_orders.total_minor END
   WHERE veo_business_orders.contact_id=EXCLUDED.contact_id AND veo_business_orders.tenant_id=EXCLUDED.tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice already belongs to another client';END IF;
 END LOOP;
END $$;

CREATE FUNCTION veo_business_orders_page(p_actor uuid,p_contact uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a veo_accounts;c contacts;BEGIN
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;SELECT * INTO c FROM contacts WHERE id=p_contact;
 IF a.user_id IS NULL OR c.id IS NULL OR NOT veo_can_page(p_actor,c.page_id) THEN RAISE EXCEPTION 'Page access denied' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('items',coalesce((SELECT jsonb_agg(to_jsonb(b)-'message_id'-'tenant_id'-'page_id'-'contact_id' ORDER BY b.occurred_at DESC,b.id) FROM veo_business_orders b WHERE b.contact_id=c.id AND b.tenant_id=a.tenant_id
 AND(b.order_id IS NULL OR EXISTS(SELECT 1 FROM veo_orders o WHERE o.id=b.order_id AND o.seller_id IN(SELECT veo_branch(p_actor))))),'[]'),
 'business_suite_url','https://business.facebook.com/latest/inbox/all?asset_id='||(SELECT fb_page_id FROM pages WHERE id=c.page_id));
END $$;

-- New sales must not silently absorb another open deal. Legacy calls keep their
-- previous auto-link behavior, while explicit new-deal calls stay independent.
DO $migration$ DECLARE definition text;BEGIN
 definition:=pg_get_functiondef('veo_action(uuid,text,jsonb)'::regprocedure);
 definition:=replace(definition,$old$SELECT * INTO d FROM veo_closed_deals WHERE tenant_id=(result->>'tenant_id')::uuid AND contact_id=(result->>'contact_id')::uuid AND seller_id=(result->>'seller_id')::uuid AND order_id IS NULL;$old$,
 $new$SELECT * INTO d FROM veo_closed_deals WHERE tenant_id=(result->>'tenant_id')::uuid AND contact_id=(result->>'contact_id')::uuid AND seller_id=(result->>'seller_id')::uuid AND order_id IS NULL AND coalesce(p_data->>'deal_mode','existing')<>'new' ORDER BY created_at DESC LIMIT 1;$new$);
 definition:=replace(definition,$old$SELECT * INTO d FROM veo_closed_deals WHERE tenant_id=o.tenant_id AND contact_id=o.contact_id AND seller_id=o.seller_id AND order_id IS NULL;$old$,
 $new$SELECT * INTO d FROM veo_closed_deals WHERE tenant_id=o.tenant_id AND contact_id=o.contact_id AND seller_id=o.seller_id AND order_id IS NULL AND o.deal_mode<>'new' ORDER BY created_at DESC LIMIT 1;$new$);
 EXECUTE definition;
 definition:=pg_get_functiondef('veo_receipt_save(uuid,jsonb)'::regprocedure);
 definition:=replace(definition,'IF d.id IS NULL THEN SELECT * INTO d FROM veo_closed_deals WHERE tenant_id=a.tenant_id',
 $new$IF d.id IS NULL AND p_data->>'deal_mode' IS DISTINCT FROM 'new' THEN SELECT * INTO d FROM veo_closed_deals WHERE tenant_id=a.tenant_id$new$);
 EXECUTE definition;
END $migration$;
ALTER FUNCTION veo_action(uuid,text,jsonb) RENAME TO veo_action_before_business_orders;
CREATE FUNCTION veo_action(p_actor uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b veo_business_orders;a veo_accounts;seller uuid;result jsonb;o veo_orders;BEGIN
 IF p_action='import_business_order' THEN
  SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;
  SELECT * INTO b FROM veo_business_orders WHERE id=(p_data->>'business_order_id')::uuid FOR UPDATE;
  seller:=(p_data->>'seller_id')::uuid;
  IF a.user_id IS NULL OR b.id IS NULL OR b.tenant_id<>a.tenant_id OR NOT veo_can_page(p_actor,b.page_id) OR NOT veo_can_page(seller,b.page_id) OR seller NOT IN(SELECT veo_descendants(p_actor)) THEN RAISE EXCEPTION 'Order outside seller branch or Page' USING ERRCODE='42501';END IF;
  IF b.price_conflict THEN RAISE EXCEPTION 'Facebook total changed after linking. Ask your supervisor to review the order before payment';END IF;
  IF b.observed_at<now()-interval '15 minutes' THEN RAISE EXCEPTION 'Fetch the latest Facebook order before selecting it';END IF;
  IF coalesce(p_data->>'deal_mode','') NOT IN('new','existing') OR(p_data->>'deal_mode'='new' AND nullif(p_data->>'closed_deal_id','') IS NOT NULL) THEN RAISE EXCEPTION 'Choose New deal or Complete existing Closed Deal';END IF;
  IF p_data->>'deal_mode'='existing' AND nullif(p_data->>'closed_deal_id','') IS NULL THEN RAISE EXCEPTION 'Select the Closed Deal to complete';END IF;
  IF b.order_id IS NOT NULL THEN
   SELECT * INTO o FROM veo_orders WHERE id=b.order_id;
   IF o.seller_id<>seller THEN RAISE EXCEPTION 'Facebook order is already assigned to another seller';END IF;
   IF o.deal_mode<>p_data->>'deal_mode' THEN RAISE EXCEPTION 'This Facebook invoice is already linked to a different deal choice';END IF;
   IF nullif(p_data->>'closed_deal_id','') IS NOT NULL THEN PERFORM veo_link_closed_deal(p_actor,(p_data->>'closed_deal_id')::uuid,o.id);END IF;
   RETURN to_jsonb(o);
  END IF;
  result:=veo_action_before_business_orders(p_actor,'order',jsonb_build_object('request_id',b.id,'page_id',b.page_id,'contact_id',b.contact_id,'seller_id',seller,
   'description','Facebook Business Suite invoice '||b.invoice_id,'total_minor',b.total_minor,'currency',b.currency,'closed_deal_id',CASE WHEN p_data->>'deal_mode'='existing' THEN p_data->>'closed_deal_id' END,'deal_mode',p_data->>'deal_mode'));
  UPDATE veo_orders SET deal_mode=p_data->>'deal_mode' WHERE id=(result->>'id')::uuid RETURNING * INTO o;
  UPDATE veo_business_orders SET order_id=o.id WHERE id=b.id;
  INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value) VALUES(a.tenant_id,p_actor,'business_suite_order_link',o.id,jsonb_build_object('invoice_id',b.invoice_id,'total_minor',b.total_minor,'deal_mode',o.deal_mode));
  RETURN to_jsonb(o);
 END IF;
 IF p_action='payment' AND EXISTS(SELECT 1 FROM veo_business_orders WHERE order_id=(p_data->>'order_id')::uuid AND price_conflict) THEN RAISE EXCEPTION 'Facebook order price changed; supervisor review required';END IF;
 IF p_action='payment' AND nullif(p_data->>'closed_deal_id','') IS NOT NULL AND EXISTS(SELECT 1 FROM veo_orders WHERE id=(p_data->>'order_id')::uuid AND deal_mode='new') THEN RAISE EXCEPTION 'This is a separate new deal; its payment cannot absorb an earlier Closed Deal';END IF;
 RETURN veo_action_before_business_orders(p_actor,p_action,p_data);
END $$;
DO $migration$ DECLARE definition text;BEGIN
 definition:=pg_get_functiondef('veo_receipt_facts(uuid)'::regprocedure);
 IF strpos(definition,'''settlement_difference_minor'',o.paid_minor-o.total_minor')=0 THEN RAISE EXCEPTION 'Receipt settlement fields are missing';END IF;
 definition:=replace(definition,'''settlement_difference_minor'',o.paid_minor-o.total_minor',
 $new$'done_balance_paid_minor',CASE WHEN r.receipt_kind='done' THEN coalesce((SELECT(payload->>'amount_minor')::bigint FROM veo_done_reconciliations WHERE order_id=o.id ORDER BY(payload->>'occurred_at')::timestamptz DESC LIMIT 1),(SELECT sum(amount_minor)::bigint FROM veo_payments WHERE order_id=o.id AND kind IN('balance','full'))) END,
 'settlement_difference_minor',o.paid_minor-o.total_minor$new$);
 EXECUTE definition;
END $migration$;
REVOKE ALL ON FUNCTION veo_action(uuid,text,jsonb),veo_observe_business_orders(uuid,uuid,jsonb),veo_business_orders_page(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_action(uuid,text,jsonb),veo_observe_business_orders(uuid,uuid,jsonb),veo_business_orders_page(uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
