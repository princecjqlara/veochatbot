BEGIN;
CREATE VIEW veo_work_facts AS
 SELECT o.*,c.name AS contact_name,c.psid,p.name AS page_name,u.name AS seller_name,a.active AS seller_active,
 coalesce(w.status,'working') AS work_status,w.assignee_id,w.completed_work_at,w.delivered_at,w.reason AS work_reason,
 o.closed_at+interval '24 hours' AS work_due_at,greatest(0,o.total_minor-o.paid_minor) AS balance_minor,
 o.closed_at IS NOT NULL AND o.paid_minor<o.total_minor AS waiting_payment,
 o.closed_at IS NOT NULL AND o.closed_at+interval '24 hours'<now() AND coalesce(w.status,'working')='working' AS overdue,
 CASE WHEN o.closed_at IS NOT NULL AND coalesce(w.status,'working')='working' THEN greatest(0,extract(epoch FROM now()-(o.closed_at+interval '24 hours'))/3600) ELSE 0 END AS overdue_hours
 FROM veo_order_facts o JOIN contacts c ON c.id=o.contact_id JOIN pages p ON p.id=o.page_id JOIN users u ON u.id=o.seller_id JOIN veo_accounts a ON a.user_id=o.seller_id LEFT JOIN veo_order_work w ON w.order_id=o.id;
REVOKE ALL ON veo_work_facts FROM PUBLIC,anon,authenticated;
GRANT SELECT ON veo_work_facts TO service_role;

CREATE FUNCTION veo_finance_days(p_actor uuid,p_from date,p_to date,p_page uuid DEFAULT NULL,p_worker uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE actor veo_accounts; result jsonb; launch date;
 BEGIN
 SELECT * INTO actor FROM veo_accounts WHERE user_id=p_actor AND active;
 SELECT (launch_at AT TIME ZONE 'Asia/Manila')::date INTO launch FROM veo_tenants WHERE id=actor.tenant_id;
 IF actor.user_id IS NULL OR launch IS NULL OR (p_page IS NOT NULL AND NOT veo_can_page(p_actor,p_page)) OR(p_worker IS NOT NULL AND p_worker NOT IN(SELECT veo_branch(p_actor))) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF p_from<launch OR p_to>veo_today() OR p_to<p_from OR p_to-p_from>92 THEN RAISE EXCEPTION 'Choose up to 93 Philippine dates within the launch period'; END IF;
 IF (SELECT count(*) FROM veo_accounts WHERE user_id IN(SELECT veo_branch(p_actor)) AND role IN('member','manager') AND(p_worker IS NULL OR user_id=p_worker))*(p_to-p_from+1)>5000 THEN RAISE EXCEPTION 'Choose an employee or a shorter salary range'; END IF;
 IF veo_today() BETWEEN p_from AND p_to THEN PERFORM veo_target(user_id,veo_today()) FROM veo_accounts WHERE active AND role IN('member','manager') AND user_id IN(SELECT veo_descendants(p_actor)) AND(p_worker IS NULL OR user_id=p_worker); END IF;
 WITH workers AS MATERIALIZED(SELECT a.*,u.name FROM veo_accounts a JOIN users u ON u.id=a.user_id WHERE a.user_id IN(SELECT veo_branch(p_actor)) AND a.role IN('member','manager') AND(p_worker IS NULL OR a.user_id=p_worker)),
 facts AS MATERIALIZED(SELECT f.* FROM veo_order_facts f WHERE f.tenant_id=actor.tenant_id AND f.seller_id IN(SELECT user_id FROM workers)),
 milestones AS(SELECT seller_id AS user_id,closed_date AS day,1 AS cd,0 AS dd,page_id FROM facts WHERE closed_date BETWEEN p_from AND p_to
 UNION ALL SELECT seller_id,done_date,0,1,page_id FROM facts WHERE done_date BETWEEN p_from AND p_to),
 counts AS(SELECT user_id,day,sum(cd)::int AS cd,sum(dd)::int AS dd,
 coalesce(sum(cd) FILTER(WHERE veo_can_page(p_actor,page_id) AND(p_page IS NULL OR page_id=p_page)),0)::int AS visible_cd,
 coalesce(sum(dd) FILTER(WHERE veo_can_page(p_actor,page_id) AND(p_page IS NULL OR page_id=p_page)),0)::int AS visible_dd FROM milestones GROUP BY user_id,day),
 frames AS(SELECT w.user_id,w.name,w.active,d::date AS day,coalesce(t.target,1) AS target,coalesce(c.cd,0) AS cd,coalesce(c.dd,0) AS dd,
 coalesce(c.visible_cd,0) AS visible_cd,coalesce(c.visible_dd,0) AS visible_dd,
 CASE WHEN coalesce(c.cd,0)>=coalesce(t.target,1) AND coalesce(c.dd,0)>=coalesce(t.target,1) THEN 40 ELSE 35 END AS rate
 FROM workers w CROSS JOIN generate_series(p_from::timestamp,p_to::timestamp,interval '1 day') d
 LEFT JOIN veo_daily_targets t ON t.user_id=w.user_id AND t.work_date=d::date LEFT JOIN counts c ON c.user_id=w.user_id AND c.day=d::date
 WHERE ((w.enrolled_at AT TIME ZONE 'Asia/Manila')::date<=d::date AND(w.departed_at IS NULL OR (w.departed_at AT TIME ZONE 'Asia/Manila')::date>=d::date)) OR c.user_id IS NOT NULL),
 page_money AS(SELECT seller_id AS user_id,done_date AS day,currency,page_id,sum(paid_minor)::bigint AS gross FROM facts WHERE done_date BETWEEN p_from AND p_to GROUP BY seller_id,done_date,currency,page_id),
 share AS(SELECT m.*,f.rate,sum(gross) OVER(PARTITION BY m.user_id,m.day,m.currency) AS total_gross FROM page_money m JOIN frames f ON f.user_id=m.user_id AND f.day=m.day),
 raw AS(SELECT *,floor(total_gross*rate/100) AS total_commission,
 CASE WHEN total_gross=0 THEN 0 ELSE floor(total_gross*rate/100)*gross/total_gross END AS share_commission FROM share),
 apportioned AS(SELECT *,floor(share_commission)::bigint+CASE WHEN row_number() OVER(PARTITION BY user_id,day,currency ORDER BY share_commission-floor(share_commission) DESC,page_id)
 <=total_commission-sum(floor(share_commission)) OVER(PARTITION BY user_id,day,currency) THEN 1 ELSE 0 END AS commission FROM raw),
 visible AS(SELECT user_id,day,currency,sum(gross)::bigint AS gross_minor,sum(commission)::bigint AS commission_minor FROM apportioned
 WHERE veo_can_page(p_actor,page_id) AND(p_page IS NULL OR page_id=p_page) GROUP BY user_id,day,currency)
 SELECT jsonb_build_object('from',p_from,'to',p_to,'days',coalesce((SELECT jsonb_agg(jsonb_build_object('user_id',f.user_id,'name',f.name,'active',f.active,'work_date',f.day,'target',f.target,'closed',f.visible_cd,'done',f.visible_dd,
 'qualified_closed',f.cd,'qualified_done',f.dd,'rate',f.rate,'provisional',f.day=veo_today(),'totals',coalesce((SELECT jsonb_agg(to_jsonb(v)-'user_id'-'day') FROM visible v WHERE v.user_id=f.user_id AND v.day=f.day),'[]')) ORDER BY f.day DESC,f.name,f.user_id) FROM frames f),'[]'),
 'coverage','Verified completion-day order values and actual 35%/40% commissions. The personal rate uses all worker Pages; filtered Page commission shares conserve the whole-day total.') INTO result;
 RETURN result;
 END $$;

CREATE FUNCTION veo_operations(p_actor uuid,p_from date,p_to date,p_page uuid DEFAULT NULL,p_worker uuid DEFAULT NULL,p_status text DEFAULT 'all',p_search text DEFAULT '',p_offset integer DEFAULT 0) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE scope jsonb; result jsonb; finance jsonb;
 BEGIN
 scope:=veo_scope(p_actor);
 IF scope IS NULL OR(p_page IS NOT NULL AND NOT veo_can_page(p_actor,p_page)) OR(p_worker IS NOT NULL AND p_worker NOT IN(SELECT veo_branch(p_actor))) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF p_status NOT IN('all','closed','done','waiting','overdue','released') OR length(p_search)>200 OR p_offset<0 OR p_offset>10000000 THEN RAISE EXCEPTION 'Invalid performance filters'; END IF;
 finance:=veo_finance_days(p_actor,p_from,p_to,p_page,p_worker);
 WITH employees AS MATERIALIZED(SELECT a.user_id AS id,a.role,a.parent_id,a.active,a.departed_at,a.enrolled_at,u.name,a.telegram_username,
 coalesce((SELECT jsonb_agg(page_id) FROM user_pages WHERE user_id=a.user_id AND veo_can_page(p_actor,page_id)),'[]') AS page_ids
 FROM veo_accounts a JOIN users u ON u.id=a.user_id WHERE a.user_id IN(SELECT veo_branch(p_actor)) AND a.role IN('member','manager') AND(p_worker IS NULL OR a.user_id=p_worker)),
 scoped AS MATERIALIZED(SELECT f.* FROM veo_work_facts f WHERE f.tenant_id=(scope->>'tenant_id')::uuid AND veo_can_page(p_actor,f.page_id) AND(p_page IS NULL OR f.page_id=p_page)
 AND(f.seller_id IN(SELECT id FROM employees) OR f.assignee_id IN(SELECT id FROM employees))),
 pool AS MATERIALIZED(SELECT f.* FROM veo_work_facts f JOIN veo_client_claims c ON c.contact_id=f.contact_id AND c.user_id IS NULL
 WHERE c.tenant_id=(scope->>'tenant_id')::uuid AND veo_can_page(p_actor,c.page_id) AND(p_page IS NULL OR c.page_id=p_page) AND(f.done_at IS NULL OR f.work_status<>'delivered')),
 filtered AS MATERIALIZED(SELECT * FROM(SELECT * FROM scoped WHERE p_status<>'released' UNION SELECT * FROM pool WHERE p_status='released') f
 WHERE(p_worker IS NULL OR seller_id=p_worker OR assignee_id=p_worker)
 AND(p_search='' OR strpos(lower(concat_ws(' ',contact_id::text,contact_name,psid,description,seller_name,page_name)),lower(p_search))>0)
 AND CASE p_status WHEN 'closed' THEN closed_date BETWEEN p_from AND p_to WHEN 'done' THEN done_date BETWEEN p_from AND p_to
 WHEN 'waiting' THEN waiting_payment WHEN 'overdue' THEN overdue WHEN 'released' THEN true
 ELSE (created_at AT TIME ZONE 'Asia/Manila')::date BETWEEN p_from AND p_to OR closed_date BETWEEN p_from AND p_to OR done_date BETWEEN p_from AND p_to END),
 stats AS(SELECT e.*,count(DISTINCT f.contact_id)::int AS clients,
 count(f.id) FILTER(WHERE f.seller_id=e.id AND f.closed_date BETWEEN p_from AND p_to)::int AS closed,count(f.id) FILTER(WHERE f.seller_id=e.id AND f.done_date BETWEEN p_from AND p_to)::int AS done,
 count(f.id) FILTER(WHERE f.seller_id=e.id AND f.waiting_payment)::int AS waiting_payment,count(f.id) FILTER(WHERE coalesce(f.assignee_id,f.seller_id)=e.id AND f.overdue)::int AS overdue,
 coalesce(max(f.overdue_hours) FILTER(WHERE coalesce(f.assignee_id,f.seller_id)=e.id),0) AS most_overdue_hours,
 count(f.id) FILTER(WHERE coalesce(f.assignee_id,f.seller_id)=e.id AND f.completed_work_at IS NOT NULL AND f.completed_work_at<=f.work_due_at)::int AS completed_on_time
 FROM employees e LEFT JOIN scoped f ON f.seller_id=e.id OR f.assignee_id=e.id GROUP BY e.id,e.role,e.parent_id,e.active,e.departed_at,e.enrolled_at,e.name,e.telegram_username,e.page_ids),
 page_metrics AS(SELECT page_id,page_name,seller_id AS user_id,
 CASE WHEN closed_date BETWEEN p_from AND p_to THEN 1 ELSE 0 END AS closed,CASE WHEN done_date BETWEEN p_from AND p_to THEN 1 ELSE 0 END AS done,
 waiting_payment::int AS waiting_payment,0 AS overdue,0::numeric AS most_overdue_hours,0 AS completed_on_time FROM scoped
 UNION ALL SELECT page_id,page_name,coalesce(assignee_id,seller_id),0,0,0,overdue::int,overdue_hours,
 CASE WHEN completed_work_at IS NOT NULL AND completed_work_at<=work_due_at THEN 1 ELSE 0 END FROM scoped),
 page_stats AS(SELECT f.page_id,f.page_name,f.user_id,e.name AS seller_name,
 sum(f.closed)::int AS closed,sum(f.done)::int AS done,sum(f.waiting_payment)::int AS waiting_payment,
 sum(f.overdue)::int AS overdue,max(f.most_overdue_hours) AS most_overdue_hours,sum(f.completed_on_time)::int AS completed_on_time
 FROM page_metrics f JOIN employees e ON e.id=f.user_id GROUP BY f.page_id,f.page_name,f.user_id,e.name)
 SELECT jsonb_build_object('scope',scope,'from',p_from,'to',p_to,'finance',finance,
 'employees',coalesce((SELECT jsonb_agg(to_jsonb(s)||jsonb_build_object('rank',rank) ORDER BY rank,name) FROM(SELECT stats.*,dense_rank() OVER(ORDER BY done DESC,closed DESC) AS rank FROM stats) s),'[]'),
 'page_rankings',coalesce((SELECT jsonb_agg(to_jsonb(s)||jsonb_build_object('rank',rank) ORDER BY page_name,rank,seller_name) FROM(SELECT page_stats.*,dense_rank() OVER(PARTITION BY page_id ORDER BY done DESC,closed DESC) AS rank FROM page_stats) s),'[]'),
 'summary',jsonb_build_object('closed',(SELECT count(*) FROM scoped WHERE closed_date BETWEEN p_from AND p_to),'done',(SELECT count(*) FROM scoped WHERE done_date BETWEEN p_from AND p_to),
 'waiting_payment',(SELECT count(*) FROM scoped WHERE waiting_payment),'overdue',(SELECT count(*) FROM scoped WHERE overdue),'released_clients',(SELECT count(*) FROM veo_client_claims c WHERE c.tenant_id=(scope->>'tenant_id')::uuid AND c.user_id IS NULL AND veo_can_page(p_actor,c.page_id) AND(p_page IS NULL OR c.page_id=p_page))),
 'orders',coalesce((SELECT jsonb_agg(to_jsonb(f) ORDER BY overdue_hours DESC,created_at DESC,id) FROM(SELECT * FROM filtered ORDER BY overdue_hours DESC,created_at DESC,id OFFSET p_offset LIMIT 50) f),'[]'),
 'order_page',jsonb_build_object('total',(SELECT count(*) FROM filtered),'offset',p_offset,'limit',50),
 'client_assignments',coalesce((SELECT jsonb_agg(to_jsonb(c)||jsonb_build_object('contact_name',ct.name,'psid',ct.psid,'page_name',pg.name,'worker_name',u.name)) FROM veo_client_claims c JOIN contacts ct ON ct.id=c.contact_id JOIN pages pg ON pg.id=c.page_id LEFT JOIN users u ON u.id=c.user_id WHERE c.tenant_id=(scope->>'tenant_id')::uuid AND veo_can_page(p_actor,c.page_id) AND(c.user_id IN(SELECT veo_branch(p_actor)) OR c.user_id IS NULL) AND(p_worker IS NULL OR c.user_id=p_worker) AND(p_page IS NULL OR c.page_id=p_page) AND(p_search='' OR strpos(lower(concat_ws(' ',ct.name,ct.psid,pg.name,u.name)),lower(p_search))>0)),'[]'),
 'ranking_scope',CASE scope->>'role' WHEN 'owner' THEN 'Overall VEO ranking' WHEN 'team_leader' THEN 'Your branch ranking' WHEN 'manager' THEN 'Your team ranking' ELSE 'Your performance' END) INTO result;
 RETURN result;
 END $$;

CREATE FUNCTION veo_calendar_finance(p_actor uuid,p_from date,p_to date,p_page uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE scope jsonb; finance jsonb; day date; daily jsonb; result jsonb:='[]'; totals jsonb; spend jsonb; cash jsonb; launch date;
 BEGIN
 scope:=veo_scope(p_actor);
 IF scope->>'role' NOT IN('owner','team_leader') OR scope IS NULL THEN RAISE EXCEPTION 'Calendar is restricted to Owner and Team Leaders' USING ERRCODE='42501'; END IF;
 launch:=((scope->>'launch_at')::timestamptz AT TIME ZONE 'Asia/Manila')::date;
 IF p_to-p_from>31 OR p_to<p_from OR(p_page IS NOT NULL AND NOT veo_can_page(p_actor,p_page)) THEN RAISE EXCEPTION 'Choose one calendar month'; END IF;
 finance:=CASE WHEN greatest(launch,p_from)>least(p_to,veo_today()) THEN jsonb_build_object('days','[]'::jsonb) ELSE veo_finance_days(p_actor,greatest(launch,p_from),least(p_to,veo_today()),p_page) END;
 FOR day IN SELECT generate_series(p_from::timestamp,p_to::timestamp,interval '1 day')::date LOOP
 SELECT coalesce(jsonb_agg(jsonb_build_object('currency',currency,'gross_minor',gross,'commission_minor',commission)),'[]') INTO totals FROM(
 SELECT t.value->>'currency' AS currency,sum((t.value->>'gross_minor')::bigint)::bigint AS gross,sum((t.value->>'commission_minor')::bigint)::bigint AS commission
 FROM jsonb_array_elements(finance->'days') d CROSS JOIN LATERAL jsonb_array_elements(d.value->'totals') t
 WHERE d.value->>'work_date'=day::text GROUP BY t.value->>'currency') x;
 spend:='[]';
 IF to_regclass('public.ad_daily_spend') IS NOT NULL THEN
 EXECUTE $query$SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') FROM(SELECT currency,round(sum(amount)*100)::bigint AS amount_minor,
 bool_and(pht_aligned AND coalesce(report_complete,false)) AS complete,count(*)::int AS records
 FROM ad_daily_spend WHERE spend_date=$1 AND veo_can_page($2,page_id) AND($3 IS NULL OR page_id=$3) GROUP BY currency) s$query$ INTO spend USING day,p_actor,p_page;
 END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') INTO cash FROM(SELECT o.currency,sum(CASE WHEN p.kind='refund' THEN -p.amount_minor ELSE p.amount_minor END)::bigint AS cash_net_minor
 FROM veo_payments p JOIN veo_orders o ON o.id=p.order_id WHERE(p.occurred_at AT TIME ZONE 'Asia/Manila')::date=day AND o.seller_id IN(SELECT veo_branch(p_actor)) AND veo_can_page(p_actor,o.page_id) AND(p_page IS NULL OR o.page_id=p_page) GROUP BY o.currency) s;
 daily:=jsonb_build_object('work_date',day,'future',day>veo_today(),'before_launch',day<launch,'provisional',day>=veo_today(),'closed',coalesce((SELECT sum((d.value->>'closed')::int) FROM jsonb_array_elements(finance->'days') d WHERE d.value->>'work_date'=day::text),0),
 'done',coalesce((SELECT sum((d.value->>'done')::int) FROM jsonb_array_elements(finance->'days') d WHERE d.value->>'work_date'=day::text),0),'totals',totals,'spend',spend,'cash',cash);
 result:=result||jsonb_build_array(daily);
 END LOOP;
 RETURN jsonb_build_object('from',p_from,'to',p_to,'days',result,'source','Verified VEO completion-day totals, actual worker commission and recorded Page ad spend. Cash receipts are shown separately; no modeled 40% salary allowance.','salary_days',finance->'days');
 END $$;

DO $$ DECLARE fn record; BEGIN
 FOR fn IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_finance_days','veo_operations','veo_calendar_finance') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn.signature); EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature); END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
