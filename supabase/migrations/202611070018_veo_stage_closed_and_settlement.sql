BEGIN;
-- Closed Deals are stage-qualified receipt events, independent of orders.
-- Their declared amount is not a verified financial payment until settlement.
ALTER TABLE veo_orders ADD COLUMN settlement_tolerance_minor integer NOT NULL DEFAULT 0 CHECK(settlement_tolerance_minor IN(0,200));
CREATE TABLE veo_closed_deals(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES veo_tenants(id),team_id uuid NOT NULL REFERENCES veo_teams(id),
 page_id uuid NOT NULL REFERENCES pages(id),contact_id uuid NOT NULL REFERENCES contacts(id),seller_id uuid NOT NULL REFERENCES veo_accounts(user_id),
 amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor<=1000000000000),currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),
 occurred_at timestamptz NOT NULL,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 order_id uuid UNIQUE REFERENCES veo_orders(id),verified_payment_id uuid UNIQUE REFERENCES veo_payments(id)
);
CREATE UNIQUE INDEX veo_closed_deal_unlinked ON veo_closed_deals(tenant_id,contact_id,seller_id) WHERE order_id IS NULL;
ALTER TABLE veo_closed_deals ENABLE ROW LEVEL SECURITY;REVOKE ALL ON veo_closed_deals FROM PUBLIC,anon,authenticated;GRANT ALL ON veo_closed_deals TO service_role;
CREATE TABLE veo_done_reconciliations(request_id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES users(id),order_id uuid NOT NULL REFERENCES veo_orders(id),payload jsonb NOT NULL,result jsonb NOT NULL);
ALTER TABLE veo_done_reconciliations ENABLE ROW LEVEL SECURITY;REVOKE ALL ON veo_done_reconciliations FROM PUBLIC,anon,authenticated;GRANT ALL ON veo_done_reconciliations TO service_role;
ALTER TABLE veo_receipts ADD COLUMN closed_deal_id uuid REFERENCES veo_closed_deals(id);
ALTER TABLE veo_submissions ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE veo_submissions ADD COLUMN closed_deal_id uuid REFERENCES veo_closed_deals(id);
ALTER TABLE veo_submissions ADD CONSTRAINT veo_submission_sale_reference CHECK(order_id IS NOT NULL OR(closed_deal_id IS NOT NULL AND receipt_kind='closed'));
CREATE UNIQUE INDEX veo_submission_closed_deal ON veo_submissions(closed_deal_id) WHERE status IN('queued','processing','delivered');

CREATE OR REPLACE VIEW veo_order_facts AS
 SELECT o.id,o.request_id,o.tenant_id,o.team_id,o.page_id,o.contact_id,o.seller_id,o.description,o.total_minor,o.currency,o.created_by,o.created_at,
 coalesce(p.paid_minor,0)::bigint AS paid_minor,p.closed_at,p.done_at,
 c.pipeline_stage IN('qualified','converted') AS converted,
 CASE WHEN c.pipeline_stage IN('qualified','converted') THEN(p.closed_at AT TIME ZONE 'Asia/Manila')::date END AS closed_date,
 CASE WHEN c.pipeline_stage IN('qualified','converted') THEN(p.done_at AT TIME ZONE 'Asia/Manila')::date END AS done_date,
 o.settlement_tolerance_minor
 FROM veo_orders o JOIN contacts c ON c.id=o.contact_id AND c.page_id=o.page_id
 LEFT JOIN LATERAL(SELECT sum(CASE WHEN kind='refund' THEN -amount_minor ELSE amount_minor END) AS paid_minor,
 min(occurred_at) FILTER(WHERE kind<>'refund') AS closed_at,
 min(occurred_at) FILTER(WHERE running>=o.total_minor OR(kind IN('full','balance') AND running>=o.total_minor-o.settlement_tolerance_minor)) AS done_at
 FROM(SELECT p.*,sum(CASE WHEN kind='refund' THEN -amount_minor ELSE amount_minor END) OVER(ORDER BY occurred_at,created_at,id) AS running FROM veo_payments p WHERE p.order_id=o.id) q) p ON true;

-- Normalized reporting events include unlinked Closed Deals, with zero verified
-- revenue and no Done date. The order_created flag prevents order actions on them.
CREATE VIEW veo_sales_facts AS
 SELECT o.id,o.request_id,o.tenant_id,o.team_id,o.page_id,o.contact_id,o.seller_id,o.description,o.total_minor,o.currency,o.created_by,o.created_at,
 o.paid_minor,coalesce(d.occurred_at,o.closed_at) AS closed_at,o.done_at,o.converted,
 CASE WHEN o.converted THEN(coalesce(d.occurred_at,o.closed_at) AT TIME ZONE 'Asia/Manila')::date END AS closed_date,o.done_date,o.settlement_tolerance_minor,
 true AS order_created,d.id AS closed_deal_id,d.amount_minor AS closed_amount_minor
 FROM veo_order_facts o LEFT JOIN veo_closed_deals d ON d.order_id=o.id
 UNION ALL
 SELECT d.id,d.id,d.tenant_id,d.team_id,d.page_id,d.contact_id,d.seller_id,'Closed Deal — order not created'::text,0::bigint,d.currency,d.created_by,d.created_at,
 0::bigint,d.occurred_at,NULL::timestamptz,c.pipeline_stage IN('qualified','converted'),
 CASE WHEN c.pipeline_stage IN('qualified','converted') THEN(d.occurred_at AT TIME ZONE 'Asia/Manila')::date END,NULL::date,0,false,d.id,d.amount_minor
 FROM veo_closed_deals d JOIN contacts c ON c.id=d.contact_id AND c.page_id=d.page_id WHERE d.order_id IS NULL;
REVOKE ALL ON veo_sales_facts FROM PUBLIC,anon,authenticated;GRANT SELECT ON veo_sales_facts TO service_role;

DO $migration$ DECLARE definition text;fn record;BEGIN
 definition:=rtrim(pg_get_viewdef('veo_work_facts'::regclass,true),E';\n ');
 definition:=replace(definition,'veo_order_facts o','veo_sales_facts o');
 definition:=replace(definition,'o.paid_minor < o.total_minor','o.paid_minor < o.total_minor - o.settlement_tolerance_minor');
 definition:=replace(definition,'GREATEST(0::bigint, o.total_minor - o.paid_minor)','CASE WHEN o.done_at IS NOT NULL AND abs(o.total_minor-o.paid_minor)<=o.settlement_tolerance_minor THEN 0::bigint ELSE GREATEST(0::bigint, o.total_minor - o.paid_minor) END');
 -- Pending order creation is already a receipt obligation, not overdue production.
 definition:=replace(definition,$old$COALESCE(w.status, 'working'::text) = 'working'::text$old$,$new$o.order_created AND COALESCE(w.status, 'working'::text) = 'working'::text$new$);
 EXECUTE 'CREATE OR REPLACE VIEW veo_work_facts AS SELECT existing.*,s.order_created,s.closed_deal_id,s.closed_amount_minor FROM('||definition||') existing JOIN veo_sales_facts s ON s.id=existing.id';
 definition:=replace(pg_get_viewdef('veo_calendar_order_values'::regclass,true),'veo_order_facts','veo_sales_facts');
 EXECUTE 'CREATE OR REPLACE VIEW veo_calendar_order_values AS '||definition;
 FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'veo_%' AND proname NOT LIKE '%action%' AND proname NOT LIKE '%receipt%' AND proname NOT LIKE '%handoff%' LOOP
  definition:=pg_get_functiondef(fn.signature);
  definition:=replace(definition,'o.paid_minor<o.total_minor','o.paid_minor<o.total_minor-o.settlement_tolerance_minor');
  definition:=replace(definition,'o.paid_minor>=o.total_minor','o.paid_minor>=o.total_minor-o.settlement_tolerance_minor');
  IF strpos(definition,'veo_order_facts')>0 THEN
   definition:=replace(definition,'veo_order_facts','veo_sales_facts');
   IF fn.signature::text LIKE 'veo_supply_target(%' OR fn.signature::text LIKE 'veo_page_supply_weight(%' THEN
    definition:=replace(definition,'paid_minor>0 AND done_at IS NULL','closed_at IS NOT NULL AND done_at IS NULL');
    definition:=replace(definition,'WHERE page_id=pg AND currency=state.currency AND closed_date','WHERE page_id=pg AND currency=state.currency AND paid_minor>0 AND closed_date');
   END IF;
   EXECUTE definition;
  END IF;
 END LOOP;
 FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND(proname LIKE 'veo_%action%' OR proname='veo_record_payment') LOOP
  definition:=pg_get_functiondef(fn.signature);
  definition:=replace(definition,'>o.total_minor)', '>o.total_minor+o.settlement_tolerance_minor)');
  definition:=replace(definition,'paid_minor=total_minor AND done_at IS NOT NULL','abs(paid_minor-total_minor)<=settlement_tolerance_minor AND done_at IS NOT NULL');
  EXECUTE definition;
 END LOOP;
 definition:=pg_get_functiondef('veo_handoff(uuid)'::regprocedure);
 definition:=replace(definition,'o.paid_minor<>o.total_minor','abs(o.paid_minor-o.total_minor)>o.settlement_tolerance_minor');
 definition:=replace(definition,'''paid_minor'',o.paid_minor,','''paid_minor'',o.paid_minor,''settlement_tolerance_minor'',o.settlement_tolerance_minor,');
 EXECUTE definition;
END $migration$;

CREATE OR REPLACE FUNCTION veo_payment_running_balance() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE maximum bigint;BEGIN
 SELECT total_minor+settlement_tolerance_minor INTO maximum FROM veo_orders WHERE id=NEW.order_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM(SELECT sum(CASE WHEN kind='refund' THEN -amount_minor ELSE amount_minor END) OVER(ORDER BY occurred_at,created_at,id) AS balance FROM veo_payments WHERE order_id=NEW.order_id) x WHERE balance<0 OR balance>maximum) THEN RAISE EXCEPTION 'Payment chronology exceeds price tolerance or refundable amount';END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION veo_receipt_recheck(p_actor uuid,p_id uuid,p_order uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r veo_receipts;f jsonb;sid uuid;BEGIN
 PERFORM veo_receipt_access(p_actor,p_id);SELECT * INTO r FROM veo_receipts WHERE id=p_id FOR UPDATE;
 IF p_order IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM veo_orders WHERE id=p_order AND tenant_id=r.tenant_id AND page_id=r.page_id AND contact_id=r.contact_id AND seller_id=r.seller_id) THEN RAISE EXCEPTION 'Choose this seller''s order for this contact';END IF;
  IF r.delivery_submission IS NOT NULL AND r.order_id IS DISTINCT FROM p_order AND NOT(r.receipt_kind='closed' AND r.closed_deal_id IS NOT NULL AND r.order_id IS NULL) THEN RAISE EXCEPTION 'A queued or delivered receipt cannot move to another order';END IF;
  IF r.closed_deal_id IS NOT NULL THEN PERFORM veo_link_closed_deal(p_actor,r.closed_deal_id,p_order);END IF;
  IF r.order_id IS DISTINCT FROM p_order THEN
   UPDATE veo_receipts SET order_id=p_order WHERE id=r.id;
   INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value) VALUES(r.tenant_id,p_actor,'receipt_order_link',r.id,to_jsonb(r.order_id),to_jsonb(p_order));
  END IF;
 END IF;
 UPDATE veo_receipts SET checked_at=clock_timestamp() WHERE id=r.id;f:=veo_receipt_facts(r.id);
 IF jsonb_array_length(f->'holds')=0 AND r.delivery_submission IS NULL THEN
  IF r.receipt_kind='closed' AND r.closed_deal_id IS NOT NULL THEN
   UPDATE veo_submissions SET status='expired' WHERE closed_deal_id=r.closed_deal_id AND status='queued' AND(expires_at<=now() OR EXISTS(SELECT 1 FROM veo_photo_objects p WHERE p.object_path=veo_submissions.object_path AND(p.expires_at<=now() OR p.deleted_at IS NOT NULL)));
   SELECT id INTO sid FROM veo_submissions WHERE closed_deal_id=r.closed_deal_id AND status IN('queued','processing','delivered') LIMIT 1;
   IF sid IS NULL THEN
    INSERT INTO veo_submissions(closed_deal_id,submitted_by,object_path,expires_at,receipt_kind) VALUES(r.closed_deal_id,r.submitted_by,r.object_path,(f->>'expires_at')::timestamptz,'closed')
    ON CONFLICT(closed_deal_id) WHERE status IN('queued','processing','delivered') DO NOTHING RETURNING id INTO sid;
    IF sid IS NULL THEN SELECT id INTO sid FROM veo_submissions WHERE closed_deal_id=r.closed_deal_id AND status IN('queued','processing','delivered') LIMIT 1;END IF;
   END IF;
  ELSE
   SELECT id INTO sid FROM veo_submissions WHERE order_id=(f->>'order_id')::uuid AND receipt_kind=r.receipt_kind AND status IN('queued','processing','delivered') LIMIT 1;
   IF sid IS NULL THEN
    INSERT INTO veo_submissions(order_id,submitted_by,object_path,expires_at,receipt_kind) VALUES((f->>'order_id')::uuid,r.submitted_by,r.object_path,(f->>'expires_at')::timestamptz,r.receipt_kind)
    ON CONFLICT(order_id,receipt_kind) WHERE status IN('queued','processing','delivered') DO NOTHING RETURNING id INTO sid;
    IF sid IS NULL THEN SELECT id INTO sid FROM veo_submissions WHERE order_id=(f->>'order_id')::uuid AND receipt_kind=r.receipt_kind AND status IN('queued','processing','delivered') LIMIT 1;END IF;
   END IF;
  END IF;
  UPDATE veo_receipts SET delivery_submission=sid WHERE id=r.id;
 ELSIF jsonb_array_length(f->'holds')=0 AND f->>'delivery_status'='blocked' AND coalesce(f->>'last_error','') NOT ILIKE '%duplicate%' AND coalesce(f->>'last_error','') NOT ILIKE '%acknowledgment%' THEN
  UPDATE veo_submissions SET status='queued',next_attempt_at=now(),last_error=NULL WHERE id=r.delivery_submission AND status='blocked';
 END IF;
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value) VALUES(r.tenant_id,p_actor,'receipt_recheck',r.id,jsonb_build_object('holds',f->'holds','salary_holds',f->'salary_holds'));
 RETURN veo_receipt_facts(r.id);
END $$;

ALTER FUNCTION veo_handoff(uuid) RENAME TO veo_handoff_before_stage;
CREATE FUNCTION veo_handoff(p_submission uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s veo_submissions;d veo_closed_deals;r veo_receipts;f jsonb;tm veo_teams;tg bigint;BEGIN
 SELECT * INTO s FROM veo_submissions WHERE id=p_submission;
 IF s.closed_deal_id IS NULL THEN RETURN veo_handoff_before_stage(p_submission);END IF;
 IF s.status NOT IN('queued','processing','delivered') OR s.deleted_at IS NOT NULL OR s.expires_at<=now() THEN RETURN NULL;END IF;
 SELECT * INTO d FROM veo_closed_deals WHERE id=s.closed_deal_id;
 SELECT * INTO r FROM veo_receipts WHERE closed_deal_id=d.id AND object_path=s.object_path;
 IF r.id IS NULL THEN RETURN NULL;END IF;f:=veo_receipt_facts(r.id);
 IF jsonb_array_length(f->'holds')>0 THEN RETURN NULL;END IF;
 SELECT * INTO tm FROM veo_teams WHERE id=d.team_id;SELECT telegram_user_id INTO tg FROM veo_worker_mappings WHERE user_id=d.seller_id;
 RETURN jsonb_build_object('submission_id',s.id,'receipt_kind','closed','tenant_id',d.tenant_id,'team_id',d.team_id,'seller_id',d.seller_id,'page_id',d.page_id,'contact_id',d.contact_id,
 'order_id',NULL,'closed_deal_id',d.id,'linked_order_id',d.order_id,'seller_name',f->>'seller_name','contact_name',f->>'contact_name','description','Closed Deal receipt; order may be created later',
 'currency',d.currency,'closed_amount_minor',d.amount_minor,'total_minor',coalesce((f->>'total_minor')::bigint,d.amount_minor),'paid_minor',coalesce((f->>'paid_minor')::bigint,0),
 'payment_verified',d.verified_payment_id IS NOT NULL,'lead_stage',f->>'lead_stage','closed_at',d.occurred_at,'done_at',NULL,'expires_at',s.expires_at,
 'telegram_chat_id',tm.telegram_chat_id,'telegram_thread_id',tm.telegram_thread_id,'telegram_user_id',tg);
END $$;



CREATE FUNCTION veo_link_closed_deal(p_actor uuid,p_closed uuid,p_order uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d veo_closed_deals;o veo_orders;BEGIN
 SELECT * INTO d FROM veo_closed_deals WHERE id=p_closed FOR UPDATE;
 SELECT * INTO o FROM veo_orders WHERE id=p_order FOR UPDATE;
 IF d.id IS NULL OR o.id IS NULL OR NOT veo_can_page(p_actor,d.page_id) OR d.seller_id NOT IN(SELECT veo_branch(p_actor))
 OR(d.tenant_id,d.page_id,d.contact_id,d.seller_id,d.currency) IS DISTINCT FROM(o.tenant_id,o.page_id,o.contact_id,o.seller_id,o.currency)
 OR d.order_id IS NOT NULL AND d.order_id<>o.id THEN RAISE EXCEPTION 'Choose the same client, seller, Page and currency for the Closed Deal and order' USING ERRCODE='42501';END IF;
 IF d.order_id IS NULL THEN
  UPDATE veo_closed_deals SET order_id=o.id WHERE id=d.id;
  UPDATE veo_receipts SET order_id=o.id WHERE closed_deal_id=d.id AND order_id IS NULL;
  INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value) VALUES(d.tenant_id,p_actor,'closed_deal_order_link',d.id,jsonb_build_object('order_id',o.id));
 END IF;
END $$;

ALTER FUNCTION veo_action(uuid,text,jsonb) RENAME TO veo_action_before_deal_rules;
CREATE FUNCTION veo_action(p_actor uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit='off' SET plan_cache_mode='force_custom_plan' AS $$
DECLARE result jsonb;o veo_orders;d veo_closed_deals;paid bigint;extra bigint;import_amount bigint:=0;pay jsonb;selected veo_payments;prior veo_done_reconciliations;BEGIN
 IF p_action='attribution' THEN
  result:=veo_action_before_deal_rules(p_actor,p_action,p_data);
  UPDATE veo_closed_deals SET seller_id=(result->>'seller_id')::uuid,team_id=(result->>'team_id')::uuid WHERE order_id=(result->>'id')::uuid;
  UPDATE veo_receipts SET seller_id=(result->>'seller_id')::uuid WHERE closed_deal_id IN(SELECT id FROM veo_closed_deals WHERE order_id=(result->>'id')::uuid);
  RETURN result;
 END IF;
 IF p_action='order' THEN
  result:=veo_action_before_deal_rules(p_actor,p_action,p_data);
  UPDATE veo_orders SET settlement_tolerance_minor=CASE WHEN currency='PHP' THEN 200 ELSE 0 END WHERE id=(result->>'id')::uuid AND NOT EXISTS(SELECT 1 FROM veo_payments WHERE order_id=veo_orders.id);
  IF nullif(p_data->>'closed_deal_id','') IS NOT NULL THEN PERFORM veo_link_closed_deal(p_actor,(p_data->>'closed_deal_id')::uuid,(result->>'id')::uuid);
  ELSE
   SELECT * INTO d FROM veo_closed_deals WHERE tenant_id=(result->>'tenant_id')::uuid AND contact_id=(result->>'contact_id')::uuid AND seller_id=(result->>'seller_id')::uuid AND order_id IS NULL;
   IF d.id IS NOT NULL THEN PERFORM veo_link_closed_deal(p_actor,d.id,(result->>'id')::uuid);END IF;
  END IF;
  RETURN result;
 END IF;
 IF p_action='payment' AND p_data->'settle_done'='true'::jsonb THEN
  SELECT * INTO o FROM veo_orders WHERE id=(p_data->>'order_id')::uuid FOR UPDATE;
  IF o.id IS NULL OR NOT veo_can_page(p_actor,o.page_id) OR o.seller_id NOT IN(SELECT veo_descendants(p_actor)) THEN RAISE EXCEPTION 'Order outside your branch or Page' USING ERRCODE='42501';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_data->>'request_id',0));
  SELECT * INTO prior FROM veo_done_reconciliations WHERE request_id=(p_data->>'request_id')::uuid;
  IF FOUND THEN IF prior.actor_id<>p_actor OR prior.order_id<>o.id OR prior.payload<>p_data THEN RAISE EXCEPTION 'Request ID conflict';END IF;RETURN prior.result;END IF;
  UPDATE veo_orders SET settlement_tolerance_minor=CASE WHEN currency='PHP' THEN 200 ELSE 0 END WHERE id=o.id RETURNING * INTO o;
  IF nullif(p_data->>'closed_deal_id','') IS NOT NULL THEN PERFORM veo_link_closed_deal(p_actor,(p_data->>'closed_deal_id')::uuid,o.id);END IF;
  IF NOT EXISTS(SELECT 1 FROM veo_closed_deals WHERE order_id=o.id) THEN
   SELECT * INTO d FROM veo_closed_deals WHERE tenant_id=o.tenant_id AND contact_id=o.contact_id AND seller_id=o.seller_id AND order_id IS NULL;
   IF d.id IS NOT NULL THEN PERFORM veo_link_closed_deal(p_actor,d.id,o.id);END IF;
  END IF;
  IF p_data->'confirmed' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Verify the Closed Deal and additional payment against actual records';END IF;
  IF p_data->'confirm_converted'='true'::jsonb THEN PERFORM veo_action_before_deal_rules(p_actor,'contact',jsonb_build_object('contact_id',o.contact_id,'pipeline_stage','converted','fields','{}'::jsonb));END IF;
  IF NOT EXISTS(SELECT 1 FROM contacts WHERE id=o.contact_id AND pipeline_stage IN('qualified','converted')) THEN RAISE EXCEPTION 'Lead stage must be Qualified or Converted';END IF;
  extra:=(p_data->>'amount_minor')::bigint;IF extra IS NULL OR extra<0 THEN RAISE EXCEPTION 'Enter a nonnegative additional payment';END IF;
  SELECT coalesce(sum(CASE WHEN kind='refund' THEN -amount_minor ELSE amount_minor END),0) INTO paid FROM veo_payments WHERE order_id=o.id;
  SELECT * INTO d FROM veo_closed_deals WHERE order_id=o.id FOR UPDATE;
  IF d.id IS NOT NULL AND d.verified_payment_id IS NULL THEN
   IF nullif(p_data->>'existing_closed_payment_id','') IS NOT NULL THEN
    SELECT * INTO selected FROM veo_payments WHERE id=(p_data->>'existing_closed_payment_id')::uuid AND order_id=o.id AND kind<>'refund';
    IF selected.id IS NULL OR selected.amount_minor<d.amount_minor THEN RAISE EXCEPTION 'Choose the saved payment covering the Closed Deal amount';END IF;
    UPDATE veo_closed_deals SET verified_payment_id=selected.id WHERE id=d.id;
   ELSIF paid=0 THEN import_amount:=d.amount_minor;
   ELSIF NOT(extra=0 AND abs(paid-o.total_minor)<=o.settlement_tolerance_minor AND d.amount_minor<=paid+o.settlement_tolerance_minor) THEN
    RAISE EXCEPTION 'Select the saved payment covering this Closed Deal so it is not recorded twice';
   END IF;
  END IF;
  IF paid+import_amount+extra<=0 THEN RAISE EXCEPTION 'An actual verified payment is required for a Done Deal';END IF;
  IF abs(paid+import_amount+extra-o.total_minor)>o.settlement_tolerance_minor THEN RAISE EXCEPTION 'Closed Deal payment plus additional verified payments must match the deal price (maximum PHP 2 difference; other currencies exact)';END IF;
  IF import_amount>0 THEN
   pay:=veo_action_before_deal_rules(p_actor,'payment',jsonb_build_object('request_id',uuid_generate_v5((p_data->>'request_id')::uuid,'closed-deal:'||d.id::text),'order_id',o.id,'kind',CASE WHEN extra=0 THEN 'full' ELSE 'deposit' END,
    'amount_minor',import_amount,'reference','Closed receipt '||d.id::text,'occurred_at',d.occurred_at,'confirmed',true));
   UPDATE veo_closed_deals SET verified_payment_id=(pay->>'id')::uuid WHERE id=d.id;
  END IF;
  IF extra>0 THEN result:=veo_action_before_deal_rules(p_actor,'payment',p_data||jsonb_build_object('kind',CASE WHEN paid+import_amount>0 THEN 'balance' ELSE 'full' END));
  ELSE result:=jsonb_build_object('order_id',o.id,'settled',true);END IF;
  IF d.id IS NOT NULL THEN UPDATE veo_closed_deals SET verified_payment_id=(SELECT id FROM veo_payments WHERE order_id=o.id AND kind<>'refund' ORDER BY occurred_at,id LIMIT 1) WHERE id=d.id AND verified_payment_id IS NULL;END IF;
  INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value) VALUES(o.tenant_id,p_actor,'done_payment_reconciliation',o.id,jsonb_build_object('closed_deal_id',d.id,'verified_total_minor',paid+import_amount+extra,'deal_price_minor',o.total_minor,'difference_minor',paid+import_amount+extra-o.total_minor));
  INSERT INTO veo_done_reconciliations VALUES((p_data->>'request_id')::uuid,p_actor,o.id,p_data,result);
  RETURN result;
 END IF;
 RETURN veo_action_before_deal_rules(p_actor,p_action,p_data);
END $$;

CREATE OR REPLACE FUNCTION veo_salary_eligibility_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o record;BEGIN
 IF OLD.pipeline_stage IS DISTINCT FROM NEW.pipeline_stage AND(OLD.pipeline_stage IN('qualified','converted') OR NEW.pipeline_stage IN('qualified','converted')) THEN
  FOR o IN SELECT id FROM veo_orders WHERE contact_id=NEW.id LOOP PERFORM veo_queue_salary_order(o.id);END LOOP;
  INSERT INTO veo_salary_reconciliation(user_id,work_date) SELECT seller_id,(occurred_at AT TIME ZONE 'Asia/Manila')::date FROM veo_closed_deals WHERE contact_id=NEW.id
  ON CONFLICT(user_id,work_date) DO UPDATE SET queued_at=clock_timestamp();
 END IF;RETURN NEW;
END $$;
CREATE FUNCTION veo_closed_salary_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 INSERT INTO veo_salary_reconciliation(user_id,work_date) VALUES(NEW.seller_id,(NEW.occurred_at AT TIME ZONE 'Asia/Manila')::date) ON CONFLICT(user_id,work_date) DO UPDATE SET queued_at=clock_timestamp();
 IF TG_OP='UPDATE' THEN
  INSERT INTO veo_salary_reconciliation(user_id,work_date) VALUES(OLD.seller_id,(OLD.occurred_at AT TIME ZONE 'Asia/Manila')::date) ON CONFLICT(user_id,work_date) DO UPDATE SET queued_at=clock_timestamp();
 END IF;
 IF NEW.order_id IS NOT NULL THEN PERFORM veo_queue_salary_order(NEW.order_id);END IF;RETURN NEW;
END $$;
CREATE TRIGGER veo_closed_salary_changed AFTER INSERT OR UPDATE ON veo_closed_deals FOR EACH ROW EXECUTE FUNCTION veo_closed_salary_changed();

CREATE OR REPLACE FUNCTION veo_receipt_facts(p_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit='off' SET plan_cache_mode='force_custom_plan' AS $$
DECLARE r veo_receipts;o veo_order_facts;c contacts;s veo_submissions;d veo_closed_deals;holds jsonb:='[]';salary_holds jsonb:='[]';tg veo_teams;deleted boolean;BEGIN
 SELECT * INTO r FROM veo_receipts WHERE id=p_id;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO c FROM contacts WHERE id=r.contact_id AND page_id=r.page_id;
 SELECT * INTO o FROM veo_order_facts WHERE id=r.order_id;
 SELECT * INTO d FROM veo_closed_deals WHERE id=r.closed_deal_id;
 SELECT * INTO s FROM veo_submissions WHERE id=r.delivery_submission;
 SELECT deleted_at IS NOT NULL OR expires_at<=now() INTO deleted FROM veo_photo_objects WHERE object_path=r.object_path;
 IF c.pipeline_stage IS NULL OR c.pipeline_stage NOT IN('qualified','converted') THEN salary_holds:=salary_holds||'"eligible_lead_required"'::jsonb;END IF;
 IF o.id IS NULL THEN salary_holds:=salary_holds||'"create_and_link_order"'::jsonb;
 ELSE
  IF o.contact_id<>r.contact_id OR o.page_id<>r.page_id OR o.seller_id<>r.seller_id THEN salary_holds:=salary_holds||'"seller_or_order_attribution_changed"'::jsonb;END IF;
  IF abs(o.paid_minor-o.total_minor)>o.settlement_tolerance_minor OR o.done_at IS NULL THEN salary_holds:=salary_holds||'"verify_full_payment"'::jsonb;END IF;
 END IF;
 holds:=salary_holds;
 IF r.receipt_kind='closed' THEN
  IF d.id IS NOT NULL THEN holds:=holds-'create_and_link_order'-'verify_full_payment';
  ELSIF o.id IS NOT NULL AND o.paid_minor>0 AND o.closed_at IS NOT NULL THEN holds:=holds-'verify_full_payment';END IF;
 END IF;
 IF coalesce(deleted,true) AND s.status IS DISTINCT FROM 'delivered' THEN holds:=holds||'"photo_expired_reupload"'::jsonb;END IF;
 IF NOT veo_can_page(r.seller_id,r.page_id) OR NOT veo_can_page(r.submitted_by,r.page_id) OR r.seller_id NOT IN(SELECT veo_descendants(r.submitted_by)) THEN holds:=holds||'"staff_or_page_access_changed"'::jsonb;END IF;
 SELECT * INTO tg FROM veo_teams WHERE id=coalesce(o.team_id,d.team_id);
 IF tg.telegram_chat_id IS NULL OR NOT EXISTS(SELECT 1 FROM veo_worker_mappings WHERE user_id=r.seller_id) THEN holds:=holds||'"telegram_mapping_required"'::jsonb;END IF;
 RETURN(to_jsonb(r)-'object_path'-'photo_sha256')||jsonb_build_object('contact_name',c.name,'lead_stage',c.pipeline_stage,'seller_name',(SELECT name FROM users WHERE id=r.seller_id),'page_name',(SELECT name FROM pages WHERE id=r.page_id),
 'order_description',o.description,'currency',coalesce(o.currency,d.currency),'total_minor',o.total_minor,'paid_minor',o.paid_minor,'closed_amount_minor',d.amount_minor,'closed_payment_verified',d.verified_payment_id IS NOT NULL,
 'settlement_difference_minor',o.paid_minor-o.total_minor,'settlement_tolerance_minor',o.settlement_tolerance_minor,
 'closed_at',coalesce(d.occurred_at,o.closed_at),'done_at',o.done_at,'expires_at',(SELECT expires_at FROM veo_photo_objects WHERE object_path=r.object_path),
 'holds',holds,'salary_holds',salary_holds,'salary_status',CASE WHEN jsonb_array_length(salary_holds)>0 THEN 'on_hold' ELSE 'counted_from_verified_ledger' END,
 'delivery_status',coalesce(s.status,CASE WHEN jsonb_array_length(holds)>0 THEN 'on_hold' ELSE 'ready_to_queue' END),'last_error',s.last_error,'delivered_at',s.delivered_at,'photo_available',NOT coalesce(deleted,true),
 'order_options',coalesce((SELECT jsonb_agg(jsonb_build_object('id',x.id,'description',x.description,'currency',x.currency,'total_minor',x.total_minor) ORDER BY x.created_at DESC) FROM veo_orders x WHERE x.contact_id=r.contact_id AND x.seller_id=r.seller_id AND x.page_id=r.page_id),'[]'));
END $$;

CREATE OR REPLACE FUNCTION veo_receipt_save(p_actor uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a veo_accounts;c contacts;seller uuid;rid uuid;existing uuid;d veo_closed_deals;team uuid;occurred timestamptz;BEGIN
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;
 SELECT * INTO c FROM contacts WHERE id=(p_data->>'contact_id')::uuid;seller:=coalesce((p_data->>'seller_id')::uuid,p_actor);
 IF a.user_id IS NULL OR c.id IS NULL OR NOT veo_can_page(p_actor,c.page_id) OR seller NOT IN(SELECT veo_descendants(p_actor)) OR NOT veo_can_page(seller,c.page_id)
 OR NOT EXISTS(SELECT 1 FROM veo_accounts WHERE user_id=seller AND tenant_id=a.tenant_id AND active AND role IN('manager','member')) THEN RAISE EXCEPTION 'Choose an authorized selling worker and contact' USING ERRCODE='42501';END IF;
 IF p_data->>'receipt_kind' NOT IN('closed','done') OR coalesce(p_data->>'object_path','') NOT LIKE a.tenant_id::text||'/'||p_actor::text||'/%'
 OR NOT EXISTS(SELECT 1 FROM veo_photo_objects WHERE object_path=p_data->>'object_path' AND expires_at>now() AND deleted_at IS NULL) THEN RAISE EXCEPTION 'Private receipt upload is required';END IF;
 SELECT r.id INTO existing FROM veo_receipts r JOIN veo_photo_objects p USING(object_path) WHERE r.tenant_id=a.tenant_id AND r.contact_id=c.id AND r.seller_id=seller AND r.receipt_kind=p_data->>'receipt_kind'
 AND(r.request_id=(p_data->>'request_id')::uuid OR(r.photo_sha256=p_data->>'photo_sha256' AND r.order_id IS NOT DISTINCT FROM nullif(p_data->>'order_id','')::uuid AND p.expires_at>now() AND p.deleted_at IS NULL)) LIMIT 1;
 IF existing IS NOT NULL THEN RETURN veo_receipt_access(p_actor,existing)||jsonb_build_object('duplicate',true);END IF;
 IF nullif(p_data->>'order_id','') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM veo_orders WHERE id=(p_data->>'order_id')::uuid AND tenant_id=a.tenant_id AND contact_id=c.id AND page_id=c.page_id AND seller_id=seller) THEN RAISE EXCEPTION 'Choose this seller''s order for this contact';END IF;
 IF p_data->>'receipt_kind'='closed' AND p_data->>'closed_amount_minor' IS NOT NULL THEN
  occurred:=(p_data->>'closed_occurred_at')::timestamptz;
  IF occurred IS NULL OR occurred<(SELECT launch_at FROM veo_tenants WHERE id=a.tenant_id) OR occurred>now() THEN RAISE EXCEPTION 'Closed Deal date must be within the launched period';END IF;
  SELECT x.* INTO d FROM veo_closed_deals x JOIN veo_receipts old ON old.closed_deal_id=x.id WHERE x.tenant_id=a.tenant_id AND x.contact_id=c.id AND x.seller_id=seller AND old.receipt_kind='closed' AND old.photo_sha256=p_data->>'photo_sha256' LIMIT 1 FOR UPDATE OF x;
  IF d.id IS NULL THEN SELECT * INTO d FROM veo_closed_deals WHERE tenant_id=a.tenant_id AND contact_id=c.id AND seller_id=seller AND(order_id IS NULL OR order_id=nullif(p_data->>'order_id','')::uuid) ORDER BY order_id NULLS FIRST LIMIT 1 FOR UPDATE;END IF;
  IF d.id IS NOT NULL AND(d.amount_minor<>(p_data->>'closed_amount_minor')::bigint OR d.currency<>upper(p_data->>'closed_currency')) THEN RAISE EXCEPTION 'An earlier Closed Deal already exists. Use its recorded amount and currency when reconciling the Done Deal';END IF;
  IF d.id IS NULL THEN
   SELECT tm.id INTO team FROM veo_teams tm JOIN veo_accounts w ON w.user_id=seller WHERE tm.manager_id=CASE WHEN w.role='manager' THEN w.user_id ELSE w.parent_id END;
   INSERT INTO veo_closed_deals(tenant_id,team_id,page_id,contact_id,seller_id,amount_minor,currency,occurred_at,created_by)
   VALUES(a.tenant_id,team,c.page_id,c.id,seller,(p_data->>'closed_amount_minor')::bigint,upper(p_data->>'closed_currency'),occurred,p_actor) RETURNING * INTO d;
  END IF;
 ELSIF nullif(p_data->>'closed_deal_id','') IS NOT NULL THEN
  SELECT * INTO d FROM veo_closed_deals WHERE id=(p_data->>'closed_deal_id')::uuid AND tenant_id=a.tenant_id AND contact_id=c.id AND seller_id=seller AND page_id=c.page_id;
  IF d.id IS NULL THEN RAISE EXCEPTION 'Closed Deal outside this client and seller' USING ERRCODE='42501';END IF;
 END IF;
 IF d.id IS NOT NULL AND nullif(p_data->>'order_id','') IS NOT NULL THEN PERFORM veo_link_closed_deal(p_actor,d.id,(p_data->>'order_id')::uuid);END IF;
 INSERT INTO veo_receipts(request_id,tenant_id,page_id,contact_id,seller_id,submitted_by,receipt_kind,order_id,object_path,photo_sha256,notes,closed_deal_id)
 VALUES((p_data->>'request_id')::uuid,a.tenant_id,c.page_id,c.id,seller,p_actor,p_data->>'receipt_kind',coalesce(nullif(p_data->>'order_id','')::uuid,d.order_id),p_data->>'object_path',p_data->>'photo_sha256',coalesce(p_data->>'notes',''),d.id) RETURNING id INTO rid;
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value) VALUES(a.tenant_id,p_actor,'receipt_submitted',rid,jsonb_build_object('seller_id',seller,'kind',p_data->>'receipt_kind','contact_id',c.id,'closed_deal_id',d.id));
 RETURN veo_receipt_recheck(p_actor,rid);
END $$;

DO $$ DECLARE fn record;BEGIN
 FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_link_closed_deal','veo_action','veo_receipt_save','veo_receipt_recheck','veo_receipt_facts','veo_handoff','veo_closed_salary_changed') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);
 END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
