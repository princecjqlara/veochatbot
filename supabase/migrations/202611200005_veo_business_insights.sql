BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';

-- On-demand summaries over existing facts. No copied records, summary table,
-- recurring worker, ad action, payroll recalculation or permission cache.
CREATE FUNCTION veo_business_insights(p_actor uuid,p_from date,p_to date,p_page uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit=off SET statement_timeout='8s' AS $$
DECLARE scope jsonb;tenant uuid;ids uuid[];launch_at timestamptz;start_at timestamptz;end_at timestamptz;asof timestamptz:=statement_timestamp();result jsonb;BEGIN
 scope:=veo_access_context(p_actor);
 IF coalesce(scope->>'role','') NOT IN('owner','team_leader') OR scope->>'launch_at' IS NULL
 OR NOT EXISTS(SELECT 1 FROM users WHERE id=p_actor AND is_active) THEN
  RAISE EXCEPTION 'Business Insights requires Owner or Team Leader access' USING ERRCODE='42501';END IF;
 tenant:=(scope->>'tenant_id')::uuid;launch_at:=(scope->>'launch_at')::timestamptz;
 IF p_from IS NULL OR p_to IS NULL OR p_from<(launch_at AT TIME ZONE 'Asia/Manila')::date OR p_to>veo_today() OR p_to<p_from OR p_to-p_from>92 THEN
  RAISE EXCEPTION 'Choose up to 93 Philippine dates from workspace launch through today' USING ERRCODE='23514';END IF;
 SELECT coalesce(array_agg(value::uuid),'{}'::uuid[]) INTO ids FROM jsonb_array_elements_text(scope->'page_ids') WHERE p_page IS NULL OR value::uuid=p_page;
 IF cardinality(ids)=0 OR cardinality(ids)>50 THEN RAISE EXCEPTION 'Choose one of your assigned Pages' USING ERRCODE='42501';END IF;
 IF (veo_storage_status()->>'resource_pressure')::boolean THEN RAISE EXCEPTION 'Insights are temporarily paused while the database recovers' USING ERRCODE='55P03';END IF;
 PERFORM veo_require_background_capacity();
 start_at:=p_from::timestamp AT TIME ZONE 'Asia/Manila';end_at:=least((p_to+1)::timestamp AT TIME ZONE 'Asia/Manila',asof);
 WITH workers AS MATERIALIZED(SELECT veo_branch(p_actor) id),
 orders AS MATERIALIZED(
  SELECT f.* FROM veo_work_facts f WHERE f.order_created AND f.tenant_id=tenant AND f.page_id=ANY(ids)
  AND f.seller_id IN(SELECT id FROM workers) AND f.created_at>=launch_at AND f.created_at<=asof
 ), payments AS MATERIALIZED(
  SELECT p.id,p.kind,p.amount_minor,o.currency,o.id order_id,o.contact_id FROM veo_payments p JOIN orders o ON o.id=p.order_id
  WHERE p.occurred_at>=start_at AND p.occurred_at<end_at
 ), money AS(
  SELECT currency,
   coalesce((SELECT sum(p.amount_minor) FROM payments p WHERE p.currency=o.currency AND p.kind<>'refund'),0)::bigint received_minor,
   coalesce((SELECT sum(p.amount_minor) FROM payments p WHERE p.currency=o.currency AND p.kind='refund'),0)::bigint refunds_minor,
   count(*) FILTER(WHERE o.balance_minor>0 AND o.paid_minor>=0)::int outstanding_orders,
   CASE WHEN bool_and(o.paid_minor>=0) THEN sum(o.balance_minor)::bigint END outstanding_minor,
   count(*) FILTER(WHERE o.paid_minor<0)::int balance_review_orders
  FROM orders o GROUP BY currency
 ), working AS MATERIALIZED(SELECT * FROM orders WHERE closed_at IS NOT NULL AND work_status='working'),
 contacts_in_scope AS MATERIALIZED(
  SELECT c.id,c.page_id,coalesce(s.first_inquiry_at,c.first_interaction_at) first_inquiry_at,
   s.attribution_status='verified_inline' AND nullif(s.origin_ad_id,'') IS NOT NULL origin_verified
  FROM contacts c LEFT JOIN ad_contact_sources s ON s.contact_id=c.id AND s.page_id=c.page_id WHERE c.page_id=ANY(ids)
 ), inquiries AS MATERIALIZED(SELECT * FROM contacts_in_scope WHERE first_inquiry_at>=start_at AND first_inquiry_at<end_at)
 SELECT jsonb_build_object('version',1,'as_of',asof,'from',p_from,'to',p_to,'launch_date',(launch_at AT TIME ZONE 'Asia/Manila')::date,'provisional',p_to=veo_today(),
  'pages',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name) ORDER BY p.name,p.id),'[]') FROM pages p WHERE p.id=ANY(ids)),
  'readiness',jsonb_build_object('page_contacts',(SELECT count(*) FROM contacts_in_scope),
   'contacts_without_inquiry_date',(SELECT count(*) FROM contacts_in_scope WHERE first_inquiry_at IS NULL),
   'inquiries',(SELECT count(*) FROM inquiries),'verified_ad_inquiries',(SELECT count(*) FROM inquiries WHERE origin_verified),
   'unknown_ad_inquiries',(SELECT count(*) FROM inquiries WHERE origin_verified IS NOT TRUE),
   'identity_checks',(SELECT coalesce(jsonb_agg(jsonb_build_object('page_id',p.id,'page_name',p.name,'checked_at',s.last_checked_at,'error',s.last_error) ORDER BY p.name,p.id),'[]') FROM pages p LEFT JOIN veo_contact_identity_sync s ON s.page_id=p.id WHERE p.id=ANY(ids))),
  'period',jsonb_build_object('created_orders',(SELECT count(*) FROM orders WHERE created_at>=start_at AND created_at<end_at),
   'paying_clients',(SELECT count(DISTINCT contact_id) FROM payments WHERE kind<>'refund'),
   'paid_orders',(SELECT count(DISTINCT order_id) FROM payments WHERE kind<>'refund'),
   'settlement_milestones',(SELECT count(*) FROM orders WHERE done_at>=start_at AND done_at<end_at),
   'refunded_orders',(SELECT count(DISTINCT order_id) FROM payments WHERE kind='refund')),
  'money',(SELECT coalesce(jsonb_agg(to_jsonb(m)||jsonb_build_object('net_cash_minor',m.received_minor-m.refunds_minor) ORDER BY currency),'[]') FROM money m),
  'backlog',jsonb_build_object('working_orders',(SELECT count(*) FROM working),'overdue_orders',(SELECT count(*) FROM working WHERE overdue),
   'ready_orders',(SELECT count(*) FROM orders WHERE work_status='ready_waiting_payment'),
   'oldest_hours',(SELECT CASE WHEN count(*)>0 THEN greatest(0,extract(epoch FROM asof-min(closed_at))/3600) END FROM working),
   'oldest_orders',(SELECT coalesce(jsonb_agg(to_jsonb(w) ORDER BY w.closed_at,w.id),'[]') FROM(SELECT id,contact_id,contact_name,page_id,page_name,seller_name,closed_at,work_due_at,overdue FROM working ORDER BY closed_at,id LIMIT 5) w))) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION veo_business_insights(uuid,date,date,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_business_insights(uuid,date,date,uuid) TO service_role;
INSERT INTO app_private.schema_migrations(version,description)
VALUES('202611200005','Read-only scoped business readiness, recorded cash, balances and work backlog; no persistent analytics copies or scheduled work') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
