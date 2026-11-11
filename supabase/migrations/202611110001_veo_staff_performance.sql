BEGIN;
SET LOCAL lock_timeout='5s';
CREATE INDEX IF NOT EXISTS veo_staff_acquisition_history ON veo_audit(tenant_id,entity_id,created_at)
 WHERE action IN('client_assignment','claim_client');

ALTER FUNCTION veo_employee_profile(uuid,uuid,date,date,uuid) RENAME TO veo_employee_profile_before_performance;
CREATE FUNCTION veo_employee_profile(p_actor uuid,p_worker uuid,p_from date,p_to date,p_page uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off SET plan_cache_mode=force_custom_plan AS $$
DECLARE base jsonb;extra jsonb;spend jsonb;tenant uuid;actor_role text;launch timestamptz;BEGIN
 -- Reuse every existing authorization, date, salary and employment check first.
 base:=veo_employee_profile_before_performance(p_actor,p_worker,p_from,p_to,p_page);
 SELECT a.tenant_id,a.role,t.launch_at INTO tenant,actor_role,launch FROM veo_accounts a JOIN veo_tenants t ON t.id=a.tenant_id WHERE a.user_id=p_actor;
 spend:=veo_calendar_spend(ARRAY(SELECT id FROM pages WHERE veo_can_page(p_actor,id) AND(p_page IS NULL OR id=p_page)),p_from,p_to);
 WITH visible AS MATERIALIZED(SELECT id,name FROM pages WHERE veo_can_page(p_actor,id)),
 branch AS MATERIALIZED(SELECT a.* FROM veo_accounts a WHERE a.tenant_id=tenant AND a.role IN('manager','member') AND a.user_id IN(SELECT veo_branch(p_actor))),
 facts AS MATERIALIZED(SELECT f.* FROM veo_work_facts f JOIN visible v ON v.id=f.page_id WHERE f.tenant_id=tenant AND f.created_at>=launch AND f.seller_id IN(SELECT user_id FROM branch)),
 personal AS MATERIALIZED(SELECT * FROM facts WHERE seller_id=p_worker AND(p_page IS NULL OR page_id=p_page)),
 milestones AS(SELECT page_id,seller_id,closed_date AS day,1 AS cd,0 AS dd FROM facts WHERE closed_date BETWEEN p_from AND p_to
 UNION ALL SELECT page_id,seller_id,done_date,0,1 FROM facts WHERE done_date BETWEEN p_from AND p_to),
 page_peers AS MATERIALIZED(SELECT b.user_id,v.id AS page_id FROM branch b CROSS JOIN visible v
 WHERE((b.enrolled_at AT TIME ZONE 'Asia/Manila')::date<=p_to AND(b.departed_at IS NULL OR(b.departed_at AT TIME ZONE 'Asia/Manila')::date>=p_from)
 AND EXISTS(SELECT 1 FROM user_pages up WHERE up.user_id=b.user_id AND up.page_id=v.id))
 OR EXISTS(SELECT 1 FROM milestones m WHERE m.seller_id=b.user_id AND m.page_id=v.id)),
 page_counts AS(SELECT p.user_id,p.page_id,coalesce(sum(m.cd),0)::int AS closed,coalesce(sum(m.dd),0)::int AS done
 FROM page_peers p LEFT JOIN milestones m ON m.seller_id=p.user_id AND m.page_id=p.page_id GROUP BY p.user_id,p.page_id),
 page_rank AS(SELECT *,dense_rank() OVER(PARTITION BY page_id ORDER BY done DESC,closed DESC) AS rank,count(*) OVER(PARTITION BY page_id)::int AS peers FROM page_counts),
 overall_counts AS(SELECT user_id,sum(closed)::int AS closed,sum(done)::int AS done FROM page_counts GROUP BY user_id),
 overall_rank AS(SELECT *,dense_rank() OVER(ORDER BY done DESC,closed DESC) AS rank,count(*) OVER()::int AS peers FROM overall_counts),
 assignment_events AS MATERIALIZED(SELECT a.entity_id AS contact_id,coalesce((a.after_value->>'claimed_at')::timestamptz,a.created_at) AS at
 FROM veo_audit a JOIN contacts c ON c.id=a.entity_id JOIN visible v ON v.id=c.page_id WHERE a.tenant_id=tenant
 AND a.action IN('client_assignment','claim_client') AND a.after_value->>'user_id'=p_worker::text
 UNION ALL SELECT c.contact_id,c.claimed_at FROM veo_client_claims c JOIN visible v ON v.id=c.page_id
 WHERE c.tenant_id=tenant AND c.user_id=p_worker AND c.claimed_at IS NOT NULL),
 acquisitions AS MATERIALIZED(SELECT e.contact_id,c.page_id,min(e.at) AS at FROM assignment_events e JOIN contacts c ON c.id=e.contact_id
 WHERE e.at>=launch AND e.at<=now() AND(p_page IS NULL OR c.page_id=p_page) GROUP BY e.contact_id,c.page_id),
 acquisition_days AS(SELECT(at AT TIME ZONE 'Asia/Manila')::date AS work_date,count(*)::int AS new_clients FROM acquisitions
 WHERE(at AT TIME ZONE 'Asia/Manila')::date BETWEEN p_from AND p_to GROUP BY 1),
 cd_times AS MATERIALIZED(SELECT id AS order_id,contact_id,page_id,contact_name,page_name,closed_at AS started_at,done_at AS finished_at,
 extract(epoch FROM done_at-closed_at)/3600 AS hours FROM personal WHERE closed_date BETWEEN p_from AND p_to AND done_at>=closed_at),
 video_times AS MATERIALIZED(SELECT f.id AS order_id,f.contact_id,f.page_id,f.contact_name,f.page_name,p.at AS started_at,f.completed_work_at AS finished_at,
 extract(epoch FROM f.completed_work_at-p.at)/3600 AS hours FROM veo_work_facts f JOIN visible v ON v.id=f.page_id
 JOIN LATERAL(SELECT min(occurred_at) AS at FROM veo_payments WHERE order_id=f.id AND kind<>'refund') p ON true
 WHERE f.tenant_id=tenant AND f.created_at>=launch AND coalesce(f.assignee_id,f.seller_id)=p_worker
 AND(p_page IS NULL OR f.page_id=p_page) AND(f.completed_work_at AT TIME ZONE 'Asia/Manila')::date BETWEEN p_from AND p_to AND f.completed_work_at>=p.at),
 dates AS MATERIALIZED(SELECT(value->>'work_date')::date AS day FROM jsonb_array_elements(base->'days')),
 staff_pages AS MATERIALIZED(SELECT up.page_id FROM user_pages up JOIN visible v ON v.id=up.page_id WHERE up.user_id=p_worker AND(p_page IS NULL OR up.page_id=p_page)
 UNION SELECT page_id FROM personal),
 costs AS MATERIALIZED(SELECT * FROM jsonb_to_recordset(spend) AS x(page_id uuid,spend_date date,currency text,amount_minor numeric,complete boolean)),
 currencies AS(SELECT DISTINCT t->>'currency' AS currency FROM jsonb_array_elements(base->'days') d CROSS JOIN LATERAL jsonb_array_elements(d->'totals') t
 UNION SELECT currency FROM costs),
 -- Allocate each Page/day's verified ad cost once, across all of its sellers.
 -- Only this worker's share is returned. The remainder method conserves cents.
 revenues AS MATERIALIZED(SELECT f.page_id,f.done_date AS day,f.currency,f.seller_id,sum(greatest(0,f.paid_minor))::numeric AS revenue
 FROM veo_work_facts f JOIN staff_pages sp ON sp.page_id=f.page_id WHERE f.tenant_id=tenant AND f.created_at>=launch AND f.done_date BETWEEN p_from AND p_to
 GROUP BY f.page_id,f.done_date,f.currency,f.seller_id),
 revenue_totals AS(SELECT page_id,day,currency,sum(revenue) AS revenue FROM revenues GROUP BY page_id,day,currency),
 weighted AS(SELECT r.*,c.amount_minor AS cost,c.amount_minor*r.revenue/t.revenue AS raw_share FROM revenues r JOIN revenue_totals t USING(page_id,day,currency)
 JOIN costs c ON c.page_id=r.page_id AND c.spend_date=r.day AND c.currency=r.currency WHERE c.complete AND t.revenue>0
 AND NOT EXISTS(SELECT 1 FROM revenue_totals other WHERE other.page_id=r.page_id AND other.day=r.day AND other.currency<>r.currency AND other.revenue>0)),
 allocated AS(SELECT *,floor(raw_share)::bigint+CASE WHEN row_number() OVER(PARTITION BY page_id,day,currency ORDER BY raw_share-floor(raw_share) DESC,seller_id)
 <=cost-sum(floor(raw_share)) OVER(PARTITION BY page_id,day,currency) THEN 1 ELSE 0 END AS share FROM weighted),
 cost_frames AS(SELECT d.day,k.currency,sp.page_id,CASE WHEN c.complete AND c.amount_minor=0 THEN 0
 WHEN c.complete AND t.revenue>0 AND NOT EXISTS(SELECT 1 FROM revenue_totals other WHERE other.page_id=sp.page_id AND other.day=d.day AND other.currency<>k.currency AND other.revenue>0)
 THEN coalesce(a.share,0) END AS share FROM dates d CROSS JOIN currencies k CROSS JOIN staff_pages sp
 LEFT JOIN costs c ON c.page_id=sp.page_id AND c.spend_date=d.day AND c.currency=k.currency
 LEFT JOIN revenue_totals t ON t.page_id=sp.page_id AND t.day=d.day AND t.currency=k.currency
 LEFT JOIN allocated a ON a.page_id=sp.page_id AND a.day=d.day AND a.currency=k.currency AND a.seller_id=p_worker),
 daily_costs AS(SELECT day AS work_date,currency,count(*)::int AS pages_expected,count(share)::int AS pages_known,
 CASE WHEN count(*)=count(share) THEN sum(share)::bigint END AS ad_cost_minor FROM cost_frames GROUP BY day,currency)
 SELECT jsonb_build_object(
 'version',1,'cost_model','Page/day ad spend allocated by verified net completed sales; remainder cents are conserved. Estimated profit excludes untracked overhead. Missing, stale, mixed-currency or unallocatable costs remain unknown.',
 'new_clients',coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY work_date) FROM acquisition_days a),'[]'),
 'current_clients',(SELECT count(*) FROM veo_client_claims c JOIN visible v ON v.id=c.page_id WHERE c.tenant_id=tenant AND c.user_id=p_worker AND(p_page IS NULL OR c.page_id=p_page)),
 'ever_assigned_clients',(SELECT count(*) FROM acquisitions),'clients_with_sales',(SELECT count(DISTINCT contact_id) FROM personal),
 'overall_ranking',(SELECT jsonb_build_object('rank',CASE WHEN actor_role<>'member' AND closed+done>0 THEN rank END,'peers',CASE WHEN actor_role<>'member' THEN peers END,'closed',closed,'done',done) FROM overall_rank WHERE user_id=p_worker),
 'page_rankings',coalesce((SELECT jsonb_agg(jsonb_build_object('page_id',p.page_id,'page_name',v.name,'rank',CASE WHEN actor_role<>'member' AND p.closed+p.done>0 THEN p.rank END,
 'peers',CASE WHEN actor_role<>'member' THEN p.peers END,'closed',p.closed,'done',p.done) ORDER BY v.name,p.page_id) FROM page_rank p JOIN visible v ON v.id=p.page_id WHERE p.user_id=p_worker),'[]'),
 'cd_turnaround',jsonb_build_object('count',(SELECT count(*) FROM cd_times),'mean_hours',(SELECT avg(hours) FROM cd_times),
 'median_hours',(SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY hours) FROM cd_times),
 'fastest',(SELECT to_jsonb(c) FROM cd_times c ORDER BY hours,order_id LIMIT 1),'slowest',(SELECT to_jsonb(c) FROM cd_times c ORDER BY hours DESC,order_id LIMIT 1)),
 'video_turnaround',jsonb_build_object('count',(SELECT count(*) FROM video_times),'mean_hours',(SELECT avg(hours) FROM video_times),
 'median_hours',(SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY hours) FROM video_times),
 'fastest',(SELECT to_jsonb(v) FROM video_times v ORDER BY hours,order_id LIMIT 1),'slowest',(SELECT to_jsonb(v) FROM video_times v ORDER BY hours DESC,order_id LIMIT 1)),
 'ad_costs',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY work_date,currency) FROM daily_costs c),'[]')) INTO extra;
 RETURN base||jsonb_build_object('performance_inputs',extra);
END $$;
REVOKE ALL ON FUNCTION veo_employee_profile(uuid,uuid,date,date,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_employee_profile(uuid,uuid,date,date,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
