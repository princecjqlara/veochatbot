BEGIN;
CREATE TABLE veo_page_capacity_weights(user_id uuid NOT NULL REFERENCES veo_accounts(user_id),page_id uuid NOT NULL REFERENCES pages(id),weight integer NOT NULL CHECK(weight BETWEEN 0 AND 1000),updated_by uuid REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,page_id));
CREATE TABLE veo_page_daily_capacity(tenant_id uuid NOT NULL REFERENCES veo_tenants(id),team_id uuid NOT NULL REFERENCES veo_teams(id),page_id uuid NOT NULL REFERENCES pages(id),work_date date NOT NULL,plan jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(team_id,page_id,work_date));
CREATE TABLE veo_ad_budget_plans(tenant_id uuid NOT NULL REFERENCES veo_tenants(id),team_id uuid NOT NULL REFERENCES veo_teams(id),page_id uuid NOT NULL REFERENCES pages(id),work_date date NOT NULL,currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),inputs jsonb NOT NULL,result jsonb NOT NULL,capacity_snapshot jsonb NOT NULL,updated_by uuid REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT now(),checked_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(team_id,page_id,work_date));
CREATE TRIGGER veo_page_capacity_readonly BEFORE UPDATE OR DELETE ON veo_page_daily_capacity FOR EACH ROW EXECUTE FUNCTION veo_freeze_completed_team_capacity();

CREATE FUNCTION veo_page_capacity(p_actor uuid,p_day date) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE actor veo_accounts; plans jsonb; row jsonb;
 BEGIN
 SELECT * INTO actor FROM veo_accounts WHERE user_id=p_actor AND active;
 IF actor.user_id IS NULL OR actor.role NOT IN('owner','team_leader') THEN RAISE EXCEPTION 'Page budget planning requires Owner or Team Leader' USING ERRCODE='42501'; END IF;
 IF p_day>veo_today()+1 OR p_day<(SELECT (launch_at AT TIME ZONE 'Asia/Manila')::date FROM veo_tenants WHERE id=actor.tenant_id) THEN RAISE EXCEPTION 'Invalid planning date'; END IF;
 IF p_day<veo_today() THEN
 SELECT coalesce(jsonb_agg(plan ORDER BY plan->>'page_name',team_id,page_id),'[]') INTO plans FROM veo_page_daily_capacity s
 WHERE s.tenant_id=actor.tenant_id AND s.work_date=p_day AND veo_can_page(p_actor,s.page_id) AND s.team_id IN(SELECT id FROM veo_teams WHERE manager_id IN(SELECT veo_branch(p_actor)));
 RETURN jsonb_build_object('work_date',p_day,'plans',plans,'historical',true,'available',jsonb_array_length(plans)>0);
 END IF;
 WITH worker_base AS MATERIALIZED(SELECT a.user_id,u.name,tm.id AS team_id,tm.name AS team_name,
 CASE WHEN p_day=veo_today() THEN veo_target(a.user_id,p_day) ELSE coalesce(dt.target,(veo_capacity(a.user_id,p_day)->>'target')::int) END AS target,att.active
 FROM veo_accounts a JOIN users u ON u.id=a.user_id JOIN veo_teams tm ON tm.manager_id=CASE WHEN a.role='manager' THEN a.user_id ELSE a.parent_id END
 LEFT JOIN veo_daily_targets dt ON dt.user_id=a.user_id AND dt.work_date=p_day LEFT JOIN veo_attendance att ON att.user_id=a.user_id AND att.work_date=p_day
 WHERE a.active AND a.role IN('manager','member') AND a.user_id IN(SELECT veo_descendants(p_actor))),
 raw AS(SELECT w.*,up.page_id,p.name AS page_name,coalesce(pw.weight,1) AS weight,
 CASE WHEN sum(coalesce(pw.weight,1)) OVER(PARTITION BY w.user_id)=0 THEN w.target::numeric/count(*) OVER(PARTITION BY w.user_id)
 ELSE coalesce(pw.weight,1)::numeric/sum(coalesce(pw.weight,1)) OVER(PARTITION BY w.user_id)*w.target END AS raw_target
 FROM worker_base w JOIN user_pages up ON up.user_id=w.user_id JOIN pages p ON p.id=up.page_id AND veo_can_page(w.user_id,p.id)
 LEFT JOIN veo_page_capacity_weights pw ON pw.user_id=w.user_id AND pw.page_id=up.page_id),
 allocated AS(SELECT *,floor(raw_target)::int+CASE WHEN row_number() OVER(PARTITION BY user_id ORDER BY raw_target-floor(raw_target) DESC,page_id)<=target-sum(floor(raw_target)) OVER(PARTITION BY user_id) THEN 1 ELSE 0 END AS page_target FROM raw),
 grouped AS(SELECT team_id,team_name,page_id,page_name,sum(page_target)::int AS full_capacity,coalesce(sum(page_target) FILTER(WHERE active IS TRUE),0)::int AS quota,
 count(*) FILTER(WHERE active IS TRUE AND page_target>0)::int AS active_workers,count(*) FILTER(WHERE active IS NULL AND page_target>0)::int AS attendance_unknown,
 coalesce(jsonb_agg(jsonb_build_object('user_id',user_id,'name',name,'target',target,'page_target',page_target,'active',active,'weight',weight) ORDER BY name,user_id),'[]') AS workers
 FROM allocated WHERE veo_can_page(p_actor,page_id) GROUP BY team_id,team_name,page_id,page_name)
 SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY page_name,team_name,page_id),'[]') INTO plans FROM grouped g;
 SELECT coalesce(jsonb_agg(value ORDER BY value->>'page_name',value->>'team_name'),'[]') INTO plans FROM(
 SELECT value FROM jsonb_array_elements(plans)
 UNION ALL
 SELECT jsonb_build_object('team_id',t.id,'team_name',t.name,'page_id',p.id,'page_name',p.name,'full_capacity',0,'quota',0,'active_workers',0,'attendance_unknown',0,'workers','[]'::jsonb)
 FROM(SELECT team_id,page_id FROM veo_ad_budget_plans WHERE work_date=p_day
 UNION SELECT team_id,page_id FROM veo_page_daily_capacity WHERE work_date=p_day) old
 JOIN veo_teams t ON t.id=old.team_id JOIN pages p ON p.id=old.page_id
 WHERE t.manager_id IN(SELECT veo_branch(p_actor)) AND veo_can_page(p_actor,p.id)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(plans) current WHERE current.value->>'team_id'=t.id::text AND current.value->>'page_id'=p.id::text)
 ) combined;
 IF p_day=veo_today() THEN
 FOR row IN SELECT value FROM jsonb_array_elements(plans) LOOP
 INSERT INTO veo_page_daily_capacity(tenant_id,team_id,page_id,work_date,plan) VALUES(actor.tenant_id,(row->>'team_id')::uuid,(row->>'page_id')::uuid,p_day,row)
 ON CONFLICT(team_id,page_id,work_date) DO UPDATE SET plan=EXCLUDED.plan,updated_at=clock_timestamp() WHERE veo_page_daily_capacity.plan IS DISTINCT FROM EXCLUDED.plan;
 END LOOP;
 END IF;
 RETURN jsonb_build_object('work_date',p_day,'plans',plans,'available',true,'basis','Individual targets are allocated across assigned Pages once, using saved weights and largest remainders. Page quotas sum participating workers. Default targets remain 1; no worker capacity is duplicated across Pages.');
 END $$;

CREATE FUNCTION veo_budget_action(p_actor uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE actor veo_accounts; plan jsonb; old jsonb; result jsonb; uid uuid; pg uuid; day date;
 BEGIN
 SELECT * INTO actor FROM veo_accounts WHERE user_id=p_actor AND active;
 IF actor.user_id IS NULL OR actor.role NOT IN('owner','team_leader') THEN RAISE EXCEPTION 'Owner or Team Leader required' USING ERRCODE='42501'; END IF;
 pg:=(p_data->>'page_id')::uuid;
 IF NOT veo_can_page(p_actor,pg) THEN RAISE EXCEPTION 'Page outside your scope' USING ERRCODE='42501'; END IF;
 IF p_action='page_weight' THEN
 uid:=(p_data->>'user_id')::uuid;
 IF uid NOT IN(SELECT veo_descendants(p_actor)) OR NOT veo_can_page(uid,pg) OR NOT EXISTS(SELECT 1 FROM veo_accounts WHERE user_id=uid AND role IN('member','manager')) THEN RAISE EXCEPTION 'Employee outside your scope' USING ERRCODE='42501'; END IF;
 SELECT to_jsonb(w) INTO old FROM veo_page_capacity_weights w WHERE user_id=uid AND page_id=pg;
 INSERT INTO veo_page_capacity_weights VALUES(uid,pg,(p_data->>'weight')::int,p_actor,now()) ON CONFLICT(user_id,page_id) DO UPDATE SET weight=EXCLUDED.weight,updated_by=p_actor,updated_at=clock_timestamp() RETURNING to_jsonb(veo_page_capacity_weights.*) INTO result;
 IF(SELECT sum(coalesce(w.weight,1)) FROM user_pages up LEFT JOIN veo_page_capacity_weights w ON w.user_id=up.user_id AND w.page_id=up.page_id WHERE up.user_id=uid AND veo_can_page(uid,up.page_id))<=0 THEN RAISE EXCEPTION 'Allocate a positive weight to at least one assigned Page'; END IF;
 ELSE
 day:=(p_data->>'work_date')::date;
 IF day NOT IN(veo_today(),veo_today()+1) THEN RAISE EXCEPTION 'Only current or tomorrow budgets can change'; END IF;
 SELECT value INTO plan FROM jsonb_array_elements(veo_page_capacity(p_actor,day)->'plans') WHERE value->>'team_id'=p_data->>'team_id' AND value->>'page_id'=pg::text;
 IF plan IS NULL THEN RAISE EXCEPTION 'Team and Page outside your branch' USING ERRCODE='42501'; END IF;
 IF (p_data->'result'->>'quota')::int<>(plan->>'quota')::int OR(p_data->'result'->>'budget')::numeric<0 OR(p_data->'result'->>'budget')::numeric>(plan->>'quota')::int*(p_data->'inputs'->>'yesterdayCPA')::numeric THEN RAISE EXCEPTION 'Capacity changed; refresh and recalculate the budget'; END IF;
 SELECT to_jsonb(b) INTO old FROM veo_ad_budget_plans b WHERE team_id=(p_data->>'team_id')::uuid AND page_id=pg AND work_date=day;
 IF old->'inputs'=p_data->'inputs' AND old->'result'=p_data->'result' AND old->'capacity_snapshot'=plan AND old->>'currency'=upper(p_data->>'currency') THEN
 UPDATE veo_ad_budget_plans SET checked_at=clock_timestamp() WHERE team_id=(p_data->>'team_id')::uuid AND page_id=pg AND work_date=day;
 RETURN old; END IF;
 INSERT INTO veo_ad_budget_plans(tenant_id,team_id,page_id,work_date,currency,inputs,result,capacity_snapshot,updated_by)
 VALUES(actor.tenant_id,(p_data->>'team_id')::uuid,pg,day,upper(p_data->>'currency'),p_data->'inputs',p_data->'result',plan,p_actor)
 ON CONFLICT(team_id,page_id,work_date) DO UPDATE SET currency=EXCLUDED.currency,inputs=EXCLUDED.inputs,result=EXCLUDED.result,capacity_snapshot=EXCLUDED.capacity_snapshot,updated_by=p_actor,updated_at=clock_timestamp(),checked_at=clock_timestamp()
 RETURNING to_jsonb(veo_ad_budget_plans.*) INTO result;
 END IF;
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value,reason) VALUES(actor.tenant_id,p_actor,p_action,pg,old,result,coalesce(p_data->>'reason','Page capacity and ad budget planning'));
 RETURN result;
 END $$;

DO $$ DECLARE t text; fn record; BEGIN
 FOREACH t IN ARRAY ARRAY['veo_page_capacity_weights','veo_page_daily_capacity','veo_ad_budget_plans'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,anon,authenticated',t);EXECUTE format('GRANT ALL ON %I TO service_role',t); END LOOP;
 FOR fn IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_page_capacity','veo_budget_action') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature); END LOOP;
END $$;
DO $migration$ DECLARE definition text; BEGIN
 definition:=pg_get_functiondef('veo_team_capacity(uuid,date)'::regprocedure);
 definition:=replace(definition,'a.active AND a.role IN(''manager'',''member'')','a.active AND EXISTS(SELECT 1 FROM pages eligible WHERE veo_can_page(a.user_id,eligible.id)) AND a.role IN(''manager'',''member'')');
 EXECUTE definition;
END $migration$;
NOTIFY pgrst,'reload schema';
COMMIT;
