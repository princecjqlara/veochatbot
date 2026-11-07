BEGIN;
CREATE INDEX IF NOT EXISTS veo_employee_assignment_history ON veo_audit(entity_id,created_at,id)
 WHERE action IN('client_assignment','claim_client');
CREATE INDEX IF NOT EXISTS veo_employee_manual_replies ON outbound_message_events(actor_user_id,contact_id,sent_at)
 WHERE source_type='manual';
-- A supervisor's replacement of a Telegram declaration is a workspace entry.
DO $migration$ DECLARE definition text; BEGIN
 definition:=pg_get_functiondef('veo_work_action(uuid,text,jsonb)'::regprocedure);
 definition:=replace(definition,'updated_by=p_actor,updated_at=EXCLUDED.updated_at;', 'updated_by=p_actor,updated_at=EXCLUDED.updated_at,source=''workspace'';');
 EXECUTE definition;
END $migration$;

-- One employee dossier. Salary uses the existing authoritative daily calculation;
-- ranking always includes all permitted peers before selecting the employee.
CREATE FUNCTION veo_employee_profile(p_actor uuid,p_worker uuid,p_from date,p_to date,p_page uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE actor veo_accounts; worker veo_accounts; tenant veo_tenants; finance jsonb; result jsonb; capacity jsonb;
 BEGIN
 SELECT * INTO actor FROM veo_accounts WHERE user_id=p_actor AND active;
 SELECT * INTO tenant FROM veo_tenants WHERE id=actor.tenant_id AND launch_at IS NOT NULL;
 SELECT * INTO worker FROM veo_accounts WHERE user_id=p_worker AND tenant_id=actor.tenant_id AND role IN('manager','member');
 IF actor.user_id IS NULL OR tenant.id IS NULL OR worker.user_id IS NULL OR p_worker NOT IN(SELECT veo_branch(p_actor))
 OR(p_page IS NOT NULL AND NOT veo_can_page(p_actor,p_page)) THEN RAISE EXCEPTION 'Employee access denied' USING ERRCODE='42501'; END IF;
 IF p_from IS NULL OR p_to IS NULL OR p_from>p_to OR p_to-p_from>92 OR p_from<(tenant.launch_at AT TIME ZONE 'Asia/Manila')::date OR p_to>veo_today()
 THEN RAISE EXCEPTION 'Choose up to 93 Philippine dates within the launched period'; END IF;
 finance:=veo_finance_days(p_actor,p_from,p_to,p_page,p_worker);
 capacity:=coalesce((SELECT basis||jsonb_build_object('target',target,'snapshot',true,'snapshot_at',created_at) FROM veo_daily_targets WHERE user_id=p_worker AND work_date=veo_today()),
 veo_capacity(p_worker,veo_today())||jsonb_build_object('snapshot',false));
 WITH visible_pages AS MATERIALIZED(SELECT id,name FROM pages WHERE veo_can_page(p_actor,id) AND(p_page IS NULL OR id=p_page)),
 facts AS MATERIALIZED(SELECT f.* FROM veo_work_facts f JOIN visible_pages p ON p.id=f.page_id WHERE f.tenant_id=actor.tenant_id
 AND f.created_at>=tenant.launch_at AND f.seller_id IN(SELECT veo_branch(p_actor))),
 personal AS MATERIALIZED(SELECT * FROM facts WHERE seller_id=p_worker),
 peers AS MATERIALIZED(SELECT a.user_id,a.enrolled_at,a.departed_at FROM veo_accounts a WHERE a.tenant_id=actor.tenant_id AND a.role IN('member','manager')
 AND a.user_id IN(SELECT veo_branch(p_actor)) AND(a.user_id=p_worker OR EXISTS(SELECT 1 FROM user_pages up JOIN visible_pages p ON p.id=up.page_id WHERE up.user_id=a.user_id) OR EXISTS(SELECT 1 FROM facts f WHERE f.seller_id=a.user_id))),
 milestones AS(SELECT seller_id AS user_id,closed_date AS day,1 AS cd,0 AS dd FROM facts WHERE closed_date BETWEEN p_from AND p_to
 UNION ALL SELECT seller_id,done_date,0,1 FROM facts WHERE done_date BETWEEN p_from AND p_to),
 counts AS(SELECT user_id,day,sum(cd)::int AS closed,sum(dd)::int AS done FROM milestones GROUP BY user_id,day),
 frames AS(SELECT p.user_id,d::date AS day,coalesce(c.closed,0) AS closed,coalesce(c.done,0) AS done FROM peers p
 CROSS JOIN generate_series(p_from::timestamp,p_to::timestamp,interval '1 day') d LEFT JOIN counts c ON c.user_id=p.user_id AND c.day=d::date
 WHERE ((p.enrolled_at AT TIME ZONE 'Asia/Manila')::date<=d::date AND(p.departed_at IS NULL OR(p.departed_at AT TIME ZONE 'Asia/Manila')::date>=d::date)) OR c.user_id IS NOT NULL),
 ranked AS(SELECT *,dense_rank() OVER(PARTITION BY day ORDER BY done DESC,closed DESC) AS rank,count(*) OVER(PARTITION BY day)::int AS peers FROM frames),
 range_counts AS(SELECT p.user_id,coalesce(sum(c.closed),0)::int AS closed,coalesce(sum(c.done),0)::int AS done FROM peers p LEFT JOIN counts c ON c.user_id=p.user_id
 WHERE EXISTS(SELECT 1 FROM frames f WHERE f.user_id=p.user_id) GROUP BY p.user_id),
 range_rank AS(SELECT *,dense_rank() OVER(ORDER BY done DESC,closed DESC) AS rank,count(*) OVER()::int AS peers FROM range_counts),
 peak_days AS(SELECT d.day,sum(d.cd)::int AS closed,sum(d.dd)::int AS done FROM(
 SELECT closed_date AS day,1 AS cd,0 AS dd FROM personal WHERE closed_date IS NOT NULL
 UNION ALL SELECT done_date,0,1 FROM personal WHERE done_date IS NOT NULL) d GROUP BY d.day),
 -- Reconstruct recorded ownership intervals, including reassignment and departure.
 -- Never give every worker on a shared Page credit for the Page's inquiries/replies.
 ownership_events AS MATERIALIZED(SELECT v.entity_id AS contact_id,(v.after_value->>'user_id')::uuid AS user_id,
 coalesce((v.after_value->>'claimed_at')::timestamptz,v.created_at) AS start_at,v.id AS seq
 FROM veo_audit v JOIN contacts c ON c.id=v.entity_id JOIN visible_pages p ON p.id=c.page_id
 WHERE v.tenant_id=actor.tenant_id AND v.action IN('client_assignment','claim_client') AND v.after_value->>'user_id' IS NOT NULL
 UNION ALL SELECT c.contact_id,c.user_id,c.claimed_at,0 FROM veo_client_claims c JOIN visible_pages p ON p.id=c.page_id
 WHERE c.tenant_id=actor.tenant_id AND c.user_id IS NOT NULL AND c.claimed_at IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM veo_audit v WHERE v.entity_id=c.contact_id AND v.action IN('client_assignment','claim_client') AND v.after_value->>'user_id'=c.user_id::text
 AND coalesce((v.after_value->>'claimed_at')::timestamptz,v.created_at)=c.claimed_at)),
 ordered_events AS(SELECT *,lag(user_id) OVER(PARTITION BY contact_id ORDER BY start_at,seq) AS previous_user FROM ownership_events),
 sequenced AS(SELECT *,lead(start_at) OVER(PARTITION BY contact_id ORDER BY start_at,seq) AS next_at FROM ordered_events WHERE previous_user IS DISTINCT FROM user_id),
 ownership AS MATERIALIZED(SELECT s.contact_id,c.page_id,c.psid,greatest(s.start_at,tenant.launch_at) AS start_at,
 least(coalesce(s.next_at,'infinity'::timestamptz),coalesce(worker.departed_at,'infinity'::timestamptz),
 CASE WHEN cc.user_id IS NULL AND cc.released_at>=s.start_at THEN cc.released_at ELSE 'infinity'::timestamptz END) AS end_at
 FROM sequenced s JOIN contacts c ON c.id=s.contact_id LEFT JOIN veo_client_claims cc ON cc.contact_id=s.contact_id
 WHERE s.user_id=p_worker AND s.start_at>=tenant.launch_at),
 assigned_cohort AS MATERIALIZED(SELECT o.contact_id,bool_or(EXISTS(SELECT 1 FROM personal f WHERE f.contact_id=o.contact_id AND f.closed_date IS NOT NULL AND f.closed_at>=o.start_at AND f.closed_at<o.end_at)) AS converted
 FROM ownership o WHERE(o.start_at AT TIME ZONE 'Asia/Manila')::date BETWEEN p_from AND p_to GROUP BY o.contact_id),
 incoming AS MATERIALIZED(SELECT DISTINCT m.page_id,m.message_id,m.client_psid,m.occurred_at,(m.occurred_at AT TIME ZONE 'Asia/Manila')::date AS day,o.contact_id,o.end_at
 FROM ownership o JOIN veo_calendar_messages m ON m.page_id=o.page_id AND m.client_psid=o.psid AND m.direction='in' AND m.occurred_at>=o.start_at AND m.occurred_at<o.end_at
 WHERE m.occurred_at>=p_from::timestamp AT TIME ZONE 'Asia/Manila' AND m.occurred_at<(p_to+1)::timestamp AT TIME ZONE 'Asia/Manila'),
 responses AS MATERIALIZED(SELECT i.*,EXISTS(SELECT 1 FROM outbound_message_events e WHERE e.actor_user_id=p_worker AND e.source_type='manual' AND e.contact_id=i.contact_id AND e.page_id=i.page_id
 AND e.sent_at>=i.occurred_at AND e.sent_at<=i.occurred_at+interval '24 hours' AND e.sent_at<i.end_at) AS answered,
 EXISTS(SELECT 1 FROM veo_calendar_messages m WHERE m.page_id=i.page_id AND m.client_psid=i.client_psid AND m.direction='out' AND m.occurred_at>=i.occurred_at
 AND m.occurred_at<=i.occurred_at+interval '24 hours' AND m.occurred_at<i.end_at AND NOT EXISTS(SELECT 1 FROM outbound_message_events e WHERE e.page_id=m.page_id AND e.message_id=m.message_id AND(e.actor_user_id IS NOT NULL OR e.source_type<>'manual'))) AS unattributed
 FROM incoming i),
 reply_days AS(SELECT day,count(DISTINCT contact_id)::int AS incoming_clients,count(DISTINCT contact_id) FILTER(WHERE answered)::int AS answered_clients,
 count(DISTINCT contact_id) FILTER(WHERE unattributed AND NOT answered)::int AS unattributed_clients FROM responses GROUP BY day),
 daily AS(SELECT d.value||jsonb_build_object('totals',coalesce((SELECT jsonb_agg(t.value||jsonb_build_object('order_gross_minor',
 (SELECT coalesce(sum(f.total_minor),0) FROM personal f WHERE f.done_date=(d.value->>'work_date')::date AND f.currency=t.value->>'currency')))
 FROM jsonb_array_elements(d.value->'totals') t),'[]'),
 'target_snapshot',EXISTS(SELECT 1 FROM veo_daily_targets dt WHERE dt.user_id=p_worker AND dt.work_date=(d.value->>'work_date')::date),
 'attendance',CASE WHEN att.user_id IS NULL THEN NULL ELSE jsonb_build_object('active',att.active,'source',att.source,'updated_at',att.updated_at) END,
 'rank',CASE WHEN actor.role<>'member' AND r.closed+r.done>0 THEN r.rank END,'peers',CASE WHEN actor.role<>'member' THEN r.peers END,
 'replies',jsonb_build_object('incoming_clients',coalesce(rd.incoming_clients,0),'answered_clients',coalesce(rd.answered_clients,0),'unattributed_clients',coalesce(rd.unattributed_clients,0))) AS value
 FROM jsonb_array_elements(finance->'days') d LEFT JOIN ranked r ON r.user_id=p_worker AND r.day=(d.value->>'work_date')::date
 LEFT JOIN veo_attendance att ON att.user_id=p_worker AND att.work_date=(d.value->>'work_date')::date LEFT JOIN reply_days rd ON rd.day=(d.value->>'work_date')::date),
 cd_cohort AS MATERIALIZED(SELECT * FROM personal WHERE closed_date BETWEEN p_from AND p_to),
 client_list AS(SELECT c.id AS contact_id,c.name,c.page_id,p.name AS page_name,cc.claimed_at,cc.user_id=p_worker AS currently_assigned,
 (SELECT count(*)::int FROM personal f WHERE f.contact_id=c.id AND f.closed_date IS NOT NULL) AS closed,
 (SELECT count(*)::int FROM personal f WHERE f.contact_id=c.id AND f.done_date IS NOT NULL) AS done,
 greatest(cc.claimed_at,(SELECT max(created_at) FROM personal f WHERE f.contact_id=c.id)) AS last_recorded_at
 FROM contacts c JOIN visible_pages p ON p.id=c.page_id LEFT JOIN veo_client_claims cc ON cc.contact_id=c.id
 WHERE cc.user_id=p_worker OR EXISTS(SELECT 1 FROM personal f WHERE f.contact_id=c.id))
 SELECT jsonb_build_object('employee',jsonb_build_object('id',p_worker,'name',(SELECT name FROM users WHERE id=p_worker),'role',worker.role,'active',worker.active,
 'enrolled_at',worker.enrolled_at,'departed_at',worker.departed_at,'telegram_username',worker.telegram_username,'supervisor',(SELECT name FROM users WHERE id=worker.parent_id),
 'pages',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.name) FROM visible_pages p JOIN user_pages up ON up.page_id=p.id WHERE up.user_id=p_worker),'[]'),
 'active_today',(SELECT active FROM veo_attendance WHERE user_id=p_worker AND work_date=veo_today()),'active_tomorrow',(SELECT active FROM veo_attendance WHERE user_id=p_worker AND work_date=veo_today()+1)),
 'from',p_from,'to',p_to,'as_of',now(),'launch_at',tenant.launch_at,'page_id',p_page,
 'ranking_scope',CASE actor.role WHEN 'owner' THEN 'Overall VEO' WHEN 'team_leader' THEN 'Your branch' WHEN 'manager' THEN 'Your team' ELSE 'Personal view; peer ranking unavailable' END,
 'ranking',(SELECT jsonb_build_object('rank',CASE WHEN actor.role<>'member' AND closed+done>0 THEN rank END,'peers',CASE WHEN actor.role<>'member' THEN peers END) FROM range_rank WHERE user_id=p_worker),
 'capacity',capacity||jsonb_build_object('work_date',veo_today(),'observed_max_done',coalesce((SELECT max(done) FROM peak_days),0),'observed_max_closed',coalesce((SELECT max(closed) FROM peak_days),0),
 'peak_done_dates',coalesce((SELECT jsonb_agg(day ORDER BY day DESC) FROM peak_days WHERE done>0 AND done=(SELECT max(done) FROM peak_days)),'[]')),
 'summary',jsonb_build_object('closed',(SELECT count(*) FROM personal WHERE closed_date BETWEEN p_from AND p_to),'done',(SELECT count(*) FROM personal WHERE done_date BETWEEN p_from AND p_to),
 'cd_cohort',(SELECT count(*) FROM cd_cohort),'cd_cohort_done',(SELECT count(*) FROM cd_cohort WHERE done_date IS NOT NULL),
 'cd_to_dd_hours_mean',(SELECT avg(extract(epoch FROM done_at-closed_at)/3600) FROM cd_cohort WHERE done_date IS NOT NULL),
 'cd_to_dd_hours_median',(SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY extract(epoch FROM done_at-closed_at)/3600) FROM cd_cohort WHERE done_date IS NOT NULL),
 'waiting_payment',(SELECT count(*) FROM personal WHERE converted AND waiting_payment),'overdue',(SELECT count(*) FROM personal WHERE converted AND overdue),
 'assigned_cohort',(SELECT count(*) FROM assigned_cohort),'assigned_cohort_converted',(SELECT count(*) FROM assigned_cohort WHERE converted),
 'reply_client_days',(SELECT coalesce(sum(incoming_clients),0) FROM reply_days),'answered_client_days',(SELECT coalesce(sum(answered_clients),0) FROM reply_days),
 'unattributed_reply_client_days',(SELECT coalesce(sum(unattributed_clients),0) FROM reply_days)),
 'reply_coverage',jsonb_build_object('pages',coalesce((SELECT jsonb_agg(jsonb_build_object('page_id',p.id,'name',p.name,'capture_from',c.capture_from)) FROM visible_pages p
 LEFT JOIN veo_calendar_message_coverage c ON c.page_id=p.id WHERE EXISTS(SELECT 1 FROM user_pages up WHERE up.user_id=p_worker AND up.page_id=p.id) OR EXISTS(SELECT 1 FROM ownership o WHERE o.page_id=p.id)),'[]')),
 'days',coalesce((SELECT jsonb_agg(value ORDER BY value->>'work_date' DESC) FROM daily),'[]'),
 'clients',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.currently_assigned DESC NULLS LAST,c.last_recorded_at DESC NULLS LAST,c.contact_id) FROM(SELECT * FROM client_list ORDER BY currently_assigned DESC NULLS LAST,last_recorded_at DESC NULLS LAST,contact_id LIMIT 50) c),'[]'),
 'client_count',(SELECT count(*) FROM client_list),'coverage','Verified workspace sales since launch. Current seller attribution and audited corrections apply. Retained legacy sales are excluded. Attendance is declared participation, not time-clock attendance. Reply counts require recorded ownership and a manual reply attributed to this worker within 24 hours; bot and unattributed Page replies do not count as personal replies.') INTO result;
 RETURN result;
 END $$;
REVOKE ALL ON FUNCTION veo_employee_profile(uuid,uuid,date,date,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_employee_profile(uuid,uuid,date,date,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
