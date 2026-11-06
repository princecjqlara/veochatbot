BEGIN;
CREATE TABLE public.veo_team_daily_capacity(
 team_id uuid NOT NULL REFERENCES veo_teams(id),work_date date NOT NULL,workers integer NOT NULL,capacity integer NOT NULL,
 participating integer NOT NULL,inactive integer NOT NULL,unknown integer NOT NULL,quota integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(team_id,work_date)
);
ALTER TABLE veo_team_daily_capacity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON veo_team_daily_capacity FROM PUBLIC,anon,authenticated;
GRANT ALL ON veo_team_daily_capacity TO service_role;
CREATE TRIGGER veo_team_capacity_readonly BEFORE UPDATE OR DELETE ON veo_team_daily_capacity FOR EACH ROW EXECUTE FUNCTION veo_readonly();
-- Shared aggregation for one team or an entire authorized branch. Averages are
-- weighted by workers/dates, never averages of separately rounded team averages.
CREATE FUNCTION public.veo_capacity_rollup(p_teams jsonb) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH teams AS(SELECT value AS v FROM jsonb_array_elements(p_teams)),
 totals AS(SELECT count(*)::int AS teams,coalesce(sum((v->>'workers')::int),0)::int AS workers,
 coalesce(sum((v->>'capacity')::int),0)::int AS capacity,coalesce(sum((v->>'quota_target')::int),0)::int AS quota,
 coalesce(sum((v->>'participating')::int),0)::int AS participating,coalesce(sum((v->>'attendance_unknown')::int),0)::int AS attendance_unknown,
 coalesce(sum((v->>'closed')::int),0)::int AS closed,coalesce(sum((v->>'done')::int),0)::int AS done,
 coalesce(sum((v#>>'{tomorrow,active}')::int),0)::int AS active,coalesce(sum((v#>>'{tomorrow,inactive}')::int),0)::int AS inactive,
 coalesce(sum((v#>>'{tomorrow,unknown}')::int),0)::int AS unknown,coalesce(sum((v#>>'{tomorrow,capacity}')::int),0)::int AS tomorrow_capacity,
 coalesce(sum((v#>>'{tomorrow,full_capacity}')::int),0)::int AS full_capacity FROM teams),
 days AS(SELECT (d->>'work_date')::date AS work_date,sum((d->>'done')::int)::int AS done
 FROM teams CROSS JOIN LATERAL jsonb_array_elements(v#>'{history,days}') d GROUP BY (d->>'work_date')::date),
 best AS(SELECT * FROM days WHERE done>0 ORDER BY done DESC,work_date DESC LIMIT 3),
 history AS(SELECT count(*)::int AS completed_days,coalesce(sum(done),0)::int AS done_total,round(avg(done),2) AS average_done_per_day,
 min(work_date) AS period_start,max(work_date) AS period_end,coalesce(jsonb_agg(to_jsonb(days) ORDER BY work_date),'[]') AS days FROM days)
 SELECT jsonb_build_object('team_count',t.teams,'workers',t.workers,'capacity',t.capacity,
 'average_worker_capacity',round(t.capacity::numeric/nullif(t.workers,0),2),'closed',t.closed,'done',t.done,
 'participating',t.participating,'attendance_unknown',t.attendance_unknown,'quota_target',t.quota,
 'quota',jsonb_build_object('closed',t.quota,'done',t.quota,'closed_percent',round(100*t.closed::numeric/nullif(t.quota,0),2),
 'done_percent',round(100*t.done::numeric/nullif(t.quota,0),2),'remaining_closed',greatest(0,t.quota-t.closed),'remaining_done',greatest(0,t.quota-t.done),
 'met',t.quota>0 AND t.closed>=t.quota AND t.done>=t.quota),
 'tomorrow',jsonb_build_object('work_date',veo_today()+1,'active',t.active,'inactive',t.inactive,'unknown',t.unknown,
 'capacity',t.tomorrow_capacity,'full_capacity',t.full_capacity,'average_active_capacity',round(t.tomorrow_capacity::numeric/nullif(t.active,0),2),
 'average_full_capacity',round(t.full_capacity::numeric/nullif(t.active+t.inactive+t.unknown,0),2)),
 'history',to_jsonb(h)||jsonb_build_object('eligible_days',(SELECT count(*) FROM days WHERE done>0),'best_days_count',(SELECT count(*) FROM best),
 'best_three_average',(SELECT CASE WHEN count(*)=3 THEN round(avg(done),2) END FROM best))) FROM totals t CROSS JOIN history h
$$;

CREATE FUNCTION public.veo_team_capacity(p_actor uuid,p_day date DEFAULT public.veo_today()) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE actor veo_accounts; launch date; tm record; worker record; workers integer; capacity integer; closed integer; done integer;
 active integer; inactive integer; unknown integer; tomorrow_capacity integer; full_capacity integer; target integer; daily jsonb; reports jsonb:='[]'; report jsonb; frozen veo_team_daily_capacity;
 BEGIN
 SELECT a.* INTO actor FROM veo_accounts a WHERE a.user_id=p_actor AND a.active;
 IF NOT FOUND THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 SELECT (launch_at AT TIME ZONE 'Asia/Manila')::date INTO launch FROM veo_tenants WHERE id=actor.tenant_id;
 IF launch IS NULL THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF p_day IS NULL OR p_day<launch OR p_day>veo_today() THEN RAISE EXCEPTION 'Date outside launched period'; END IF;
 FOR tm IN SELECT t.*,u.name AS manager_name,a.parent_id AS leader_id FROM veo_teams t JOIN veo_accounts a ON a.user_id=t.manager_id JOIN users u ON u.id=a.user_id
 WHERE t.tenant_id=actor.tenant_id AND a.active AND
 (t.manager_id IN(SELECT veo_descendants(p_actor)) OR(actor.role='member' AND t.manager_id=actor.parent_id)) ORDER BY t.name,t.id LOOP
 SELECT * INTO frozen FROM veo_team_daily_capacity WHERE team_id=tm.id AND work_date=p_day;
 IF NOT FOUND THEN
 INSERT INTO veo_team_daily_capacity(team_id,work_date,workers,capacity,participating,inactive,unknown,quota)
 SELECT tm.id,p_day,count(*)::int,coalesce(sum(veo_target(a.user_id,p_day)),0)::int,count(*) FILTER(WHERE att.active IS TRUE)::int,
 count(*) FILTER(WHERE att.active IS FALSE)::int,count(*) FILTER(WHERE att.active IS NULL)::int,
 coalesce(sum(veo_target(a.user_id,p_day)) FILTER(WHERE att.active IS TRUE),0)::int
 FROM veo_accounts a LEFT JOIN veo_attendance att ON att.user_id=a.user_id AND att.work_date=p_day
 WHERE a.tenant_id=actor.tenant_id AND a.active AND a.role IN('manager','member') AND(a.user_id=tm.manager_id OR a.parent_id=tm.manager_id)
 ON CONFLICT DO NOTHING;
 SELECT * INTO frozen FROM veo_team_daily_capacity WHERE team_id=tm.id AND work_date=p_day;
 END IF;
 workers:=0; capacity:=0; active:=0; inactive:=0; unknown:=0; tomorrow_capacity:=0; full_capacity:=0;
 FOR worker IN SELECT a.user_id,att.active,dt.target FROM veo_accounts a LEFT JOIN veo_attendance att ON att.user_id=a.user_id AND att.work_date=veo_today()+1
 LEFT JOIN veo_daily_targets dt ON dt.user_id=a.user_id AND dt.work_date=veo_today()+1
 WHERE a.tenant_id=actor.tenant_id AND a.active AND a.role IN('manager','member') AND(a.user_id=tm.manager_id OR a.parent_id=tm.manager_id) LOOP
 workers:=workers+1; capacity:=capacity+veo_target(worker.user_id,p_day);
 target:=coalesce(worker.target,(veo_capacity(worker.user_id,veo_today()+1)->>'target')::int); full_capacity:=full_capacity+target;
 IF worker.active IS TRUE THEN active:=active+1; tomorrow_capacity:=tomorrow_capacity+target;
 ELSIF worker.active IS FALSE THEN inactive:=inactive+1; ELSE unknown:=unknown+1; END IF;
 END LOOP;
 SELECT count(*) FILTER(WHERE closed_date=p_day),count(*) FILTER(WHERE done_date=p_day) INTO closed,done FROM veo_order_facts WHERE team_id=tm.id AND veo_can_page(p_actor,page_id);
 SELECT coalesce(jsonb_agg(jsonb_build_object('work_date',d.work_date,'done',coalesce(f.n,0)) ORDER BY d.work_date),'[]') INTO daily
 FROM(SELECT generate_series(greatest(launch,p_day-14)::timestamp,(p_day-1)::timestamp,interval '1 day')::date AS work_date) d
 LEFT JOIN(SELECT done_date,count(*)::int AS n FROM veo_order_facts WHERE team_id=tm.id AND veo_can_page(p_actor,page_id) AND done_date>=greatest(launch,p_day-14) AND done_date<p_day GROUP BY done_date) f ON f.done_date=d.work_date;
 report:=jsonb_build_object('id',tm.id,'name',tm.name,'manager_id',tm.manager_id,'manager_name',tm.manager_name,'leader_id',tm.leader_id,
 'work_date',p_day,'workers',frozen.workers,'capacity',frozen.capacity,'quota_target',frozen.quota,'participating',frozen.participating,'attendance_unknown',frozen.unknown,'closed',closed,'done',done,
 'tomorrow',jsonb_build_object('active',active,'inactive',inactive,'unknown',unknown,'capacity',tomorrow_capacity,'full_capacity',full_capacity),
 'coverage','Team results include only Pages currently assigned to the viewer. Capacity and participation use the frozen team roster.',
 'history',jsonb_build_object('days',daily));
 report:=report||veo_capacity_rollup(jsonb_build_array(report)); reports:=reports||jsonb_build_array(report);
 END LOOP;
 RETURN jsonb_build_object('work_date',p_day,'basis','Team quotas sum frozen targets of declared active workers; full capacity includes every selling worker. Daily roster and participation snapshots are immutable. Historical averages combine Done Deals per completed Philippine date since launch.',
 'teams',reports,'combined',veo_capacity_rollup(reports));
 END $$;

DO $migration$
 DECLARE definition text;
 BEGIN
 definition:=pg_get_functiondef('public.veo_jaucian_report(uuid,date)'::regprocedure);
 IF strpos(definition,'DECLARE result jsonb;')=0 OR strpos(definition,'RETURN result;')=0 THEN RAISE EXCEPTION 'Jaucian report migration source mismatch'; END IF;
 definition:=replace(definition,'DECLARE result jsonb;','DECLARE result jsonb; capacities jsonb;');
 definition:=replace(definition,'RETURN result;',$new$capacities:=veo_team_capacity((SELECT owner_id FROM veo_tenants WHERE id=p_tenant),p_day);
 RETURN result||jsonb_build_object('teams',coalesce((SELECT jsonb_agg(t.value||jsonb_build_object('capacity',
 (SELECT c.value FROM jsonb_array_elements(capacities->'teams') c WHERE c.value->>'id'=t.value->>'id')))
 FROM jsonb_array_elements(result->'teams') t),'[]'),'combined_capacity',capacities->'combined');$new$);
 EXECUTE definition;
 -- Capture today's roster and declared participation during ordinary maintenance;
 -- attendance updates for tomorrow never rewrite these immutable day snapshots.
 definition:=pg_get_functiondef('public.veo_maintenance()'::regprocedure);
 IF strpos(definition,'DELETE FROM veo_login_limits')=0 THEN RAISE EXCEPTION 'Maintenance migration source mismatch'; END IF;
 definition:=replace(definition,'DELETE FROM veo_login_limits',$new$PERFORM veo_team_capacity(t.owner_id,veo_today()) FROM veo_tenants t WHERE t.launch_at IS NOT NULL;
 DELETE FROM veo_login_limits$new$);
 EXECUTE definition;
 END $migration$;
REVOKE ALL ON FUNCTION veo_capacity_rollup(jsonb),veo_team_capacity(uuid,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_capacity_rollup(jsonb),veo_team_capacity(uuid,date) TO service_role;
COMMIT;
