BEGIN;

-- Preserve the existing exact commission allocation while adding explicit
-- before-refund ledger components. No financial rows are copied or rewritten.
DO $migration$ DECLARE definition text;BEGIN
 definition:=regexp_replace(pg_get_viewdef('veo_calendar_order_values'::regclass,true),'[;[:space:]]+$','');
 IF strpos(definition,'financial_source')=0 THEN RAISE EXCEPTION 'Calendar financial source is missing';END IF;
 EXECUTE 'CREATE OR REPLACE VIEW veo_calendar_order_values AS SELECT base.*,
  coalesce(w.gross,l.gross,0)::bigint AS gross_before_refunds_minor,
  coalesce(w.refunds,l.refunds,0)::bigint AS refunds_minor
 FROM ('||definition||') base
 LEFT JOIN LATERAL(SELECT sum(amount_minor) FILTER(WHERE kind<>''refund'') AS gross,
  sum(amount_minor) FILTER(WHERE kind=''refund'') AS refunds FROM veo_payments
  WHERE order_id=base.id AND occurred_at<=now() AND base.financial_source=''workspace'') w ON true
 LEFT JOIN LATERAL(SELECT sum(p.amount_minor) FILTER(WHERE p.kind<>''refund'') AS gross,
  sum(p.amount_minor) FILTER(WHERE p.kind=''refund'') AS refunds FROM contact_verified_payments p
  JOIN veo_tenants t ON t.id=base.tenant_id WHERE p.purchase_id=base.id AND p.voided_at IS NULL
  AND p.occurred_at<t.launch_at AND p.occurred_at<=now() AND base.financial_source=''retained'') l ON true';
END $migration$;

CREATE INDEX veo_business_orders_calendar_created ON veo_business_orders(tenant_id,page_id,occurred_at);
CREATE INDEX veo_orders_calendar_created ON veo_orders(tenant_id,page_id,created_at);

CREATE FUNCTION veo_calendar_created_orders(p_actor uuid,p_from date,p_to date,p_page uuid DEFAULT NULL)
RETURNS TABLE(order_key text,page_id uuid,contact_id uuid,currency text,total_minor bigint,paid_minor bigint,
 balance_minor bigint,created_at timestamptz,created_date date,source text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit='off' AS $$
DECLARE a veo_accounts;BEGIN
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active AND role IN('owner','team_leader');
 IF a.user_id IS NULL OR(p_page IS NOT NULL AND NOT veo_can_page(p_actor,p_page)) THEN RAISE EXCEPTION 'Calendar access denied' USING ERRCODE='42501';END IF;
 IF p_to<p_from OR p_to-p_from>31 THEN RAISE EXCEPTION 'Choose one calendar month';END IF;
 RETURN QUERY
 SELECT 'facebook:'||b.page_id||':'||b.invoice_id,b.page_id,b.contact_id,b.currency,b.total_minor,
  f.paid_minor,CASE WHEN f.id IS NULL THEN NULL WHEN f.done_at IS NOT NULL AND abs(b.total_minor-f.paid_minor)<=linked.settlement_tolerance_minor THEN 0 ELSE greatest(0,b.total_minor-f.paid_minor) END,
  b.occurred_at,(b.occurred_at AT TIME ZONE 'Asia/Manila')::date,'facebook'::text
 FROM veo_business_orders b JOIN veo_tenants t ON t.id=b.tenant_id
 LEFT JOIN veo_order_facts f ON f.id=b.order_id
 LEFT JOIN veo_orders linked ON linked.id=b.order_id
 WHERE b.tenant_id=a.tenant_id AND veo_can_page(p_actor,b.page_id) AND(p_page IS NULL OR b.page_id=p_page)
 AND b.occurred_at>=t.launch_at AND b.occurred_at>=(p_from::timestamp AT TIME ZONE 'Asia/Manila')
 AND b.occurred_at<least(((p_to+1)::timestamp AT TIME ZONE 'Asia/Manila'),now())
 AND(a.role='owner' OR f.seller_id IN(SELECT veo_branch(p_actor)) OR(b.order_id IS NULL AND EXISTS(
  SELECT 1 FROM veo_client_claims c WHERE c.contact_id=b.contact_id AND c.user_id IN(SELECT veo_branch(p_actor)))))
 UNION ALL
 SELECT 'workspace:'||o.id,o.page_id,o.contact_id,o.currency,o.total_minor,o.paid_minor,
  CASE WHEN o.done_at IS NOT NULL AND abs(o.total_minor-o.paid_minor)<=v.settlement_tolerance_minor THEN 0 ELSE greatest(0,o.total_minor-o.paid_minor) END,
  o.created_at,(o.created_at AT TIME ZONE 'Asia/Manila')::date,'workspace'::text
 FROM veo_order_facts o JOIN veo_orders v ON v.id=o.id JOIN veo_tenants t ON t.id=o.tenant_id
 WHERE o.tenant_id=a.tenant_id AND veo_can_page(p_actor,o.page_id) AND(p_page IS NULL OR o.page_id=p_page)
 AND(a.role='owner' OR o.seller_id IN(SELECT veo_branch(p_actor)))
 AND o.created_at>=t.launch_at AND o.created_at>=(p_from::timestamp AT TIME ZONE 'Asia/Manila')
 AND o.created_at<least(((p_to+1)::timestamp AT TIME ZONE 'Asia/Manila'),now())
 AND NOT EXISTS(SELECT 1 FROM veo_business_orders b WHERE b.order_id=o.id);
END $$;

-- Generate the day-detail read from the installed, bounded demographic/cohort
-- CTEs, retaining the exact extraction and authorization semantics.
DO $migration$ DECLARE definition text;cohort text;details text;start_at integer;end_at integer;BEGIN
 definition:=replace(pg_get_functiondef('veo_calendar_inputs(uuid,date,date,date,uuid)'::regprocedure),E'\r\n',E'\n');
 start_at:=strpos(definition,' WITH cohort_base AS MATERIALIZED(');end_at:=strpos(definition,' orders AS MATERIALIZED(');
 IF start_at=0 OR end_at<=start_at THEN RAISE EXCEPTION 'Bounded calendar cohort is missing';END IF;
 cohort:=substr(definition,start_at,end_at-start_at);
 start_at:=strpos(definition,' selected AS MATERIALIZED(');end_at:=strpos(definition,' messages AS(');
 IF start_at=0 OR end_at<=start_at THEN RAISE EXCEPTION 'Calendar day detail sources are missing';END IF;
 details:=regexp_replace(substr(definition,start_at,end_at-start_at),',[[:space:]]*$','');
 EXECUTE 'CREATE FUNCTION veo_calendar_day_details(p_actor uuid,p_day date,p_page uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit=''off'' AS $body$
 DECLARE p_from date:=p_day;p_to date:=p_day;scoped_role text;scoped_tenant uuid;actor veo_accounts;ids uuid[];result jsonb;BEGIN
 SELECT * INTO actor FROM veo_accounts WHERE user_id=p_actor AND active AND role IN(''owner'',''team_leader'');
 IF actor.user_id IS NULL OR p_day IS NULL OR(p_page IS NOT NULL AND NOT veo_can_page(p_actor,p_page)) THEN
  RAISE EXCEPTION ''Calendar access denied'' USING ERRCODE=''42501'';END IF;
 SELECT array_agg(id) INTO ids FROM pages WHERE veo_can_page(p_actor,id) AND(p_page IS NULL OR id=p_page);
 scoped_role:=actor.role;scoped_tenant:=actor.tenant_id;'||cohort||details||'
 SELECT jsonb_build_object(''as_of'',statement_timestamp(),''selected_day'',p_day,
  ''selected_clients'',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY inquiry_at,id) FROM selected s),''[]''),
  ''peer_lag_hours'',coalesce((SELECT jsonb_agg(CASE WHEN converted_at IS NOT NULL THEN extract(epoch FROM converted_at-first_inquiry_at)/3600 ELSE NULL END) FROM peer),''[]'')) INTO result;
 RETURN result;END $body$';
 IF strpos(definition,'''orders'',coalesce')=0 THEN RAISE EXCEPTION 'Calendar order projection is missing';END IF;
 definition:=replace(definition,'''orders'',coalesce',
  '''created_orders'',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM veo_calendar_created_orders(p_actor,p_from,p_to,p_page) x),''[]''),''orders'',coalesce');
 EXECUTE definition;
END $migration$;

REVOKE ALL ON FUNCTION veo_calendar_created_orders(uuid,date,date,uuid),veo_calendar_day_details(uuid,date,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_calendar_created_orders(uuid,date,date,uuid),veo_calendar_day_details(uuid,date,uuid) TO service_role;
REVOKE ALL ON veo_calendar_order_values FROM PUBLIC,anon,authenticated;
GRANT SELECT ON veo_calendar_order_values TO service_role;
INSERT INTO app_private.schema_migrations(version,description) VALUES('202611090005','Calendar earnings components, actual order creation dates and separate day detail reads') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
