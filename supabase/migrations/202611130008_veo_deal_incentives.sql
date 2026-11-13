BEGIN;
CREATE TABLE veo_deal_incentives(order_id uuid PRIMARY KEY REFERENCES veo_orders(id),percent numeric(5,2) NOT NULL CHECK(percent BETWEEN 0 AND 60),reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),actor_id uuid NOT NULL REFERENCES users(id),version integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE veo_incentive_reasons(actor_id uuid NOT NULL REFERENCES users(id),reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),PRIMARY KEY(actor_id,reason));
CREATE TABLE veo_incentive_notices(id uuid PRIMARY KEY,order_id uuid NOT NULL REFERENCES veo_orders(id),percent numeric(5,2) NOT NULL,reason text NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),queued_at timestamptz,next_attempt_at timestamptz NOT NULL DEFAULT now(),UNIQUE(order_id,id));
ALTER TABLE veo_deal_incentives ENABLE ROW LEVEL SECURITY;
ALTER TABLE veo_incentive_reasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE veo_incentive_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON veo_deal_incentives,veo_incentive_reasons,veo_incentive_notices FROM PUBLIC,anon,authenticated;
GRANT ALL ON veo_deal_incentives,veo_incentive_reasons,veo_incentive_notices TO service_role;

CREATE FUNCTION veo_incentive_context(p_actor uuid,p_kind text,p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a veo_accounts;r jsonb;o veo_order_facts;BEGIN
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;
 IF p_kind='review' THEN r:=veo_deal_review_access(p_actor,p_id);
 ELSIF p_kind='receipt' THEN r:=veo_receipt_access(p_actor,p_id);
 ELSE RAISE EXCEPTION 'Choose a receipt or deal';END IF;
 SELECT * INTO o FROM veo_order_facts WHERE id=(r->>'order_id')::uuid;
 IF a.user_id IS NULL OR NOT EXISTS(SELECT 1 FROM users WHERE id=p_actor AND is_active) THEN RAISE EXCEPTION 'Inactive account' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('order_id',o.id,'can_edit',a.role IN('manager','team_leader') AND o.id IS NOT NULL AND r->>'deleted_at' IS NULL AND (p_kind='receipt' OR r->>'status'='approved'),
 'incentive',(SELECT to_jsonb(i) FROM veo_deal_incentives i WHERE order_id=o.id),'saved_reasons',coalesce((SELECT jsonb_agg(reason ORDER BY reason) FROM veo_incentive_reasons WHERE actor_id=p_actor),'[]'),
 'currency',o.currency,'paid_minor',o.paid_minor,'payable',o.done_at IS NOT NULL,'estimated_minor',coalesce((SELECT floor(o.paid_minor*percent/100)::bigint FROM veo_deal_incentives WHERE order_id=o.id),0));
END $$;

CREATE FUNCTION veo_incentive_save(p_actor uuid,p_kind text,p_id uuid,p_percent numeric,p_reason text,p_expected integer,p_request uuid,p_save_reason boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ctx jsonb;oid uuid;v integer;f veo_order_facts;old jsonb;BEGIN
 ctx:=veo_incentive_context(p_actor,p_kind,p_id);oid:=(ctx->>'order_id')::uuid;
 IF NOT coalesce((ctx->>'can_edit')::boolean,false) THEN RAISE EXCEPTION 'Only the permitted Manager or Team Leader can award an incentive on an approved linked deal' USING ERRCODE='42501';END IF;
 IF p_percent IS NULL OR p_percent<0 OR p_percent>60 OR p_percent<>round(p_percent,2) OR p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 3 AND 500 OR p_request IS NULL OR p_expected IS NULL THEN RAISE EXCEPTION 'Enter 0 to 60 percent and a reason of 3 to 500 characters';END IF;
 PERFORM 1 FROM veo_orders WHERE id=oid FOR UPDATE;
 IF EXISTS(SELECT 1 FROM veo_incentive_notices WHERE id=p_request) THEN
  IF NOT EXISTS(SELECT 1 FROM veo_incentive_notices WHERE id=p_request AND order_id=oid AND actor_id=p_actor AND percent=p_percent AND reason=trim(p_reason)) THEN RAISE EXCEPTION 'Request already used for a different incentive';END IF;
  RETURN veo_incentive_context(p_actor,p_kind,p_id);
 END IF;
 SELECT to_jsonb(i),i.version INTO old,v FROM veo_deal_incentives i WHERE order_id=oid;
 IF coalesce(v,0)<>p_expected THEN RAISE EXCEPTION 'The incentive changed. Refresh before saving';END IF;
 INSERT INTO veo_deal_incentives(order_id,percent,reason,actor_id) VALUES(oid,p_percent,trim(p_reason),p_actor)
 ON CONFLICT(order_id) DO UPDATE SET percent=excluded.percent,reason=excluded.reason,actor_id=excluded.actor_id,version=veo_deal_incentives.version+1,updated_at=now();
 IF p_save_reason THEN
  IF (SELECT count(*) FROM veo_incentive_reasons WHERE actor_id=p_actor)>=100 AND NOT EXISTS(SELECT 1 FROM veo_incentive_reasons WHERE actor_id=p_actor AND reason=trim(p_reason)) THEN RAISE EXCEPTION 'You can save up to 100 reasons';END IF;
  INSERT INTO veo_incentive_reasons VALUES(p_actor,trim(p_reason)) ON CONFLICT DO NOTHING;
 END IF;
 SELECT * INTO f FROM veo_order_facts WHERE id=oid;
 INSERT INTO veo_incentive_notices(id,order_id,percent,reason,actor_id) VALUES(p_request,oid,p_percent,trim(p_reason),p_actor);
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value) VALUES(f.tenant_id,p_actor,'deal_incentive',oid,old,jsonb_build_object('percent',p_percent,'reason',trim(p_reason)));
 IF f.done_date IS NOT NULL THEN INSERT INTO veo_salary_reconciliation(user_id,work_date) VALUES(f.seller_id,f.done_date) ON CONFLICT(user_id,work_date) DO UPDATE SET queued_at=now();END IF;
 RETURN veo_incentive_context(p_actor,p_kind,p_id);
END $$;

ALTER FUNCTION veo_salary(uuid,date) RENAME TO veo_salary_before_incentives;
CREATE FUNCTION veo_salary(p_user uuid,p_day date) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;totals jsonb;BEGIN
 result:=veo_salary_before_incentives(p_user,p_day);
 SELECT coalesce(jsonb_agg(t.value||jsonb_build_object('base_commission_minor',(t.value->>'commission_minor')::bigint,'incentive_minor',coalesce(b.amount,0),'commission_minor',(t.value->>'commission_minor')::bigint+coalesce(b.amount,0))),'[]') INTO totals
 FROM jsonb_array_elements(result->'totals') t LEFT JOIN LATERAL(SELECT sum(floor(f.paid_minor*i.percent/100))::bigint amount FROM veo_order_facts f JOIN veo_deal_incentives i ON i.order_id=f.id WHERE f.seller_id=p_user AND f.done_date=p_day AND f.currency=t.value->>'currency') b ON true;
 RETURN result||jsonb_build_object('totals',totals);
END $$;

DO $$ DECLARE definition text;BEGIN
 definition:=pg_get_functiondef('veo_finance_days(uuid,date,date,uuid,uuid)'::regprocedure);
 IF strpos(definition,'sum(commission)::bigint AS commission_minor')=0 THEN RAISE EXCEPTION 'Finance integration point missing';END IF;
 definition:=replace(definition,'sum(commission)::bigint AS commission_minor','(sum(commission)+coalesce((SELECT sum(floor(f.paid_minor*i.percent/100)) FROM veo_order_facts f JOIN veo_deal_incentives i ON i.order_id=f.id WHERE f.seller_id=apportioned.user_id AND f.done_date=apportioned.day AND f.currency=apportioned.currency AND veo_can_page(p_actor,f.page_id) AND(p_page IS NULL OR f.page_id=p_page)),0))::bigint AS commission_minor');
 EXECUTE definition;
END $$;

-- Keep calendar net earnings aligned with the additional salary cost.
DO $$ DECLARE definition text;columns text;BEGIN
 definition:=regexp_replace(pg_get_viewdef('veo_calendar_order_values'::regclass,true),'[;[:space:]]+$','');
 SELECT string_agg(CASE WHEN attname='commission_minor' THEN '(base.commission_minor+CASE WHEN base.financial_source=''workspace'' AND base.done_at IS NOT NULL THEN coalesce((SELECT floor(base.paid_minor*i.percent/100)::bigint FROM veo_deal_incentives i WHERE i.order_id=base.id),0) ELSE 0 END)::bigint AS commission_minor' ELSE 'base.'||quote_ident(attname) END,',' ORDER BY attnum) INTO columns FROM pg_attribute WHERE attrelid='veo_calendar_order_values'::regclass AND attnum>0 AND NOT attisdropped;
 EXECUTE 'CREATE OR REPLACE VIEW veo_calendar_order_values AS SELECT '||columns||' FROM ('||definition||') base';
END $$;

CREATE FUNCTION veo_incentive_notice(p_id uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('id',n.id,'tenant_id',f.tenant_id,'telegram_chat_id',(route.destination->>'chat_id')::bigint,'telegram_thread_id',(route.destination->>'thread_id')::bigint,'text',
 'VEO · DEAL INCENTIVE' || chr(10) || 'Seller: ' || u.name || chr(10) || 'Client: ' || coalesce(c.name,'Client') || chr(10) || 'Extra commission: +' || n.percent || '%' || chr(10) || 'Reason: ' || n.reason || chr(10) || 'Awarded by: ' || a.name || chr(10) || 'Order: ' || f.id || chr(10) || 'Replaces any earlier incentive for this order. Applies to verified paid principal when eligible for salary; tips excluded.')
 FROM veo_incentive_notices n JOIN veo_order_facts f ON f.id=n.order_id JOIN contacts c ON c.id=f.contact_id JOIN users u ON u.id=f.seller_id JOIN users a ON a.id=n.actor_id
 CROSS JOIN LATERAL (SELECT veo_telegram_destination(f.team_id,f.page_id,f.seller_id) destination) route WHERE n.id=p_id AND route.destination->>'chat_id' IS NOT NULL
$$;

DO $$ DECLARE f record;BEGIN FOR f IN SELECT oid::regprocedure sig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_incentive_context','veo_incentive_save','veo_incentive_notice','veo_salary','veo_salary_before_incentives') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.sig);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.sig);END LOOP;END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
