BEGIN;
CREATE TABLE veo_ad_planning_state(page_id uuid NOT NULL REFERENCES pages(id),account_id text NOT NULL,currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),active_ads integer NOT NULL CHECK(active_ads>=0),
 allocated_daily_budget_minor bigint CHECK(allocated_daily_budget_minor>=0),budget_mode text NOT NULL,checked_at timestamptz NOT NULL,basis text NOT NULL,PRIMARY KEY(page_id,account_id));
ALTER TABLE veo_ad_planning_state ENABLE ROW LEVEL SECURITY;REVOKE ALL ON veo_ad_planning_state FROM PUBLIC,anon,authenticated;GRANT ALL ON veo_ad_planning_state TO service_role;
CREATE TABLE veo_operating_quotas(user_id uuid NOT NULL REFERENCES veo_accounts(user_id),work_date date NOT NULL,capacity integer NOT NULL CHECK(capacity>=1),quota integer NOT NULL CHECK(quota>=0),basis jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,work_date));
ALTER TABLE veo_operating_quotas ENABLE ROW LEVEL SECURITY;REVOKE ALL ON veo_operating_quotas FROM PUBLIC,anon,authenticated;GRANT ALL ON veo_operating_quotas TO service_role;
CREATE TRIGGER veo_operating_quota_readonly BEFORE UPDATE OR DELETE ON veo_operating_quotas FOR EACH ROW EXECUTE FUNCTION veo_readonly();
CREATE FUNCTION veo_supply_target(p_user uuid,p_day date,p_capacity integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit='off' SET plan_cache_mode='force_custom_plan' AS $$
DECLARE pg uuid;state record;backlog integer;support integer:=0;known boolean:=true;no_ads boolean:=true;pages jsonb:='[]';spend numeric;payers integer;cpa numeric;slots integer;share integer;BEGIN
 SELECT count(DISTINCT contact_id)::int INTO backlog FROM veo_order_facts WHERE seller_id=p_user AND paid_minor>0 AND done_at IS NULL AND veo_can_page(p_user,page_id);
 FOR pg IN SELECT id FROM pages WHERE veo_can_page(p_user,id) LOOP
  SELECT count(*)::int AS accounts,bool_and(checked_at>=now()-interval '3 hours') AS fresh,sum(active_ads)::int AS active_ads,
  CASE WHEN count(*)=count(allocated_daily_budget_minor) AND count(DISTINCT currency)=1 THEN sum(allocated_daily_budget_minor) END AS budget,min(currency) AS currency
  INTO state FROM veo_ad_planning_state WHERE page_id=pg;
  IF state.accounts=0 OR NOT coalesce(state.fresh,false) THEN known:=false;pages:=pages||jsonb_build_object('page_id',pg,'state','unknown');CONTINUE;END IF;
  IF state.active_ads=0 THEN pages:=pages||jsonb_build_object('page_id',pg,'state','no_ads','budget_minor',0);CONTINUE;END IF;
  no_ads:=false;
  SELECT sum(amount_minor)::numeric INTO spend FROM veo_ad_spend_coverage WHERE page_id=pg AND currency=state.currency AND spend_date>=p_day-14 AND spend_date<least(p_day,veo_today()) AND report_complete AND pht_aligned;
  SELECT count(DISTINCT contact_id)::int INTO payers FROM veo_order_facts WHERE page_id=pg AND currency=state.currency AND closed_date>=p_day-14 AND closed_date<least(p_day,veo_today());
  cpa:=CASE WHEN spend>0 AND payers>0 THEN spend/payers END;
  SELECT greatest(1,count(*))::int INTO share FROM veo_accounts a JOIN user_pages up ON up.user_id=a.user_id AND up.page_id=pg WHERE a.active AND a.role IN('member','manager') AND veo_can_page(a.user_id,pg);
  IF state.budget IS NULL OR cpa IS NULL THEN known:=false;slots:=0;ELSE slots:=greatest(0,floor(state.budget/cpa/share))::int;support:=support+slots;END IF;
  pages:=pages||jsonb_build_object('page_id',pg,'state','ads_active','allocated_daily_budget_minor',state.budget,'currency',state.currency,'observed_cpa_minor',cpa,'supported_per_worker',CASE WHEN cpa IS NULL OR state.budget IS NULL THEN NULL ELSE slots END);
 END LOOP;
 RETURN jsonb_build_object('capacity',p_capacity,'quota',CASE WHEN known THEN least(p_capacity,backlog+support) ELSE p_capacity END,
 'supply_known',known,'ad_mode',CASE WHEN NOT known THEN 'unknown' WHEN no_ads THEN 'no_ads' ELSE 'ads_active' END,'open_paid_clients',backlog,'funded_new_clients',support,'pages',pages,
 'policy','Frozen daily operating quota is limited by proven capacity, existing paid unfinished clients, and allocated daily ads / observed CPA. Unknown/lifetime budgets retain the capacity target. No ads alone do not erase existing client work. Salary still requires Converted + order + full verified payment.');
END $$;

-- Existing completed-day targets remain intact. Only uncompleted current/future
-- days receive a new, once-only operating snapshot; production capacity stays
-- separately available through veo_capacity.
CREATE OR REPLACE FUNCTION veo_target(p_user uuid,p_day date) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit='off' SET plan_cache_mode='force_custom_plan' AS $$
DECLARE basis jsonb;result integer;capacity integer;quota jsonb;BEGIN
 IF p_day>=veo_today() THEN
  SELECT greatest(1,q.quota) INTO result FROM veo_operating_quotas q WHERE q.user_id=p_user AND q.work_date=p_day;IF FOUND THEN RETURN result;END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user::text||':'||p_day,0));
  SELECT greatest(1,q.quota) INTO result FROM veo_operating_quotas q WHERE q.user_id=p_user AND q.work_date=p_day;IF FOUND THEN RETURN result;END IF;
  basis:=veo_capacity(p_user,p_day);capacity:=(basis->>'target')::int;quota:=veo_supply_target(p_user,p_day,capacity);
  INSERT INTO veo_operating_quotas VALUES(p_user,p_day,capacity,(quota->>'quota')::int,quota,now());
  result:=greatest(1,(quota->>'quota')::int);
  INSERT INTO veo_daily_targets VALUES(p_user,p_day,result,basis||jsonb_build_object('operating',quota),now()) ON CONFLICT(user_id,work_date) DO UPDATE SET target=EXCLUDED.target,basis=EXCLUDED.basis;
  INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value,reason) SELECT tenant_id,p_user,'operating_quota_snapshot',p_user,quota||jsonb_build_object('work_date',p_day),'Daily capacity and available-work snapshot; completed days unchanged' FROM veo_accounts WHERE user_id=p_user;
  RETURN result;
 END IF;
 SELECT target INTO result FROM veo_daily_targets WHERE user_id=p_user AND work_date=p_day;IF FOUND THEN RETURN result;END IF;
 basis:=veo_capacity(p_user,p_day);
 INSERT INTO veo_daily_targets VALUES(p_user,p_day,(basis->>'target')::int,basis,now()) ON CONFLICT DO NOTHING;
 RETURN(SELECT target FROM veo_daily_targets WHERE user_id=p_user AND work_date=p_day);
END $$;

CREATE FUNCTION veo_operating_quota(p_user uuid,p_day date) RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT quota FROM veo_operating_quotas WHERE user_id=p_user AND work_date=p_day),
 CASE WHEN p_day>veo_today() THEN(veo_supply_target(p_user,p_day,(veo_capacity(p_user,p_day)->>'target')::int)->>'quota')::int END,
 (SELECT target FROM veo_daily_targets WHERE user_id=p_user AND work_date=p_day),(veo_capacity(p_user,p_day)->>'target')::int)
$$;
DO $migration$ DECLARE definition text;BEGIN
 definition:=pg_get_functiondef('veo_team_capacity(uuid,date)'::regprocedure);
 definition:=replace(definition,'sum(veo_target(a.user_id,p_day)) FILTER','sum(veo_operating_quota(a.user_id,p_day)) FILTER');
 definition:=replace(definition,'sum(veo_target(a.user_id,p_day))','sum((veo_capacity(a.user_id,p_day)->>''target'')::int)');
 definition:=replace(definition,'tomorrow_capacity:=tomorrow_capacity+target','tomorrow_capacity:=tomorrow_capacity+veo_operating_quota(worker.user_id,veo_today()+1)');EXECUTE definition;
 definition:=pg_get_functiondef('veo_page_capacity(uuid,date)'::regprocedure);
 definition:=replace(definition,'veo_target(a.user_id,p_day) ELSE coalesce(dt.target,(veo_capacity(a.user_id,p_day)->>''target'')::int)',
 'veo_operating_quota(a.user_id,p_day) ELSE veo_operating_quota(a.user_id,p_day)');
 definition:=replace(definition,' WITH worker_base AS MATERIALIZED(', ' IF p_day=veo_today() THEN PERFORM veo_target(a.user_id,p_day) FROM veo_accounts a WHERE a.active AND a.role IN(''member'',''manager'') AND a.user_id IN(SELECT veo_descendants(p_actor));END IF; WITH worker_base AS MATERIALIZED(');
 definition:=replace(definition,' AS target,att.active',' AS target,(veo_capacity(a.user_id,p_day)->>''target'')::int AS production_target,att.active');
 definition:=replace(definition,' AS raw_target',
 ' AS raw_target,CASE WHEN sum(coalesce(pw.weight,1)) OVER(PARTITION BY w.user_id)=0 THEN w.production_target::numeric/count(*) OVER(PARTITION BY w.user_id) ELSE coalesce(pw.weight,1)::numeric/sum(coalesce(pw.weight,1)) OVER(PARTITION BY w.user_id)*w.production_target END AS raw_capacity');
 definition:=replace(definition,' AS page_target FROM raw)',
 ' AS page_target,floor(raw_capacity)::int+CASE WHEN row_number() OVER(PARTITION BY user_id ORDER BY raw_capacity-floor(raw_capacity) DESC,page_id)<=production_target-sum(floor(raw_capacity)) OVER(PARTITION BY user_id) THEN 1 ELSE 0 END AS page_capacity FROM raw)');
 definition:=replace(definition,'sum(page_target)::int AS full_capacity','sum(page_capacity)::int AS full_capacity');
 definition:=replace(definition,'''target'',target,''page_target'',page_target','''target'',target,''production_target'',production_target,''page_capacity'',page_capacity,''page_target'',page_target');
 EXECUTE definition;
 definition:=pg_get_functiondef('veo_salary(uuid,date)'::regprocedure);
 definition:=replace(definition,'''provisional'',p_day>=veo_today()', '''operating_quota'',veo_operating_quota(p_user,p_day),''production_capacity'',(veo_capacity(p_user,p_day)->>''target'')::int,''quota_basis'',(SELECT basis FROM veo_operating_quotas WHERE user_id=p_user AND work_date=p_day),''provisional'',p_day>=veo_today()');EXECUTE definition;
END $migration$;
REVOKE ALL ON FUNCTION veo_supply_target(uuid,date,integer),veo_operating_quota(uuid,date) FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION veo_supply_target(uuid,date,integer),veo_operating_quota(uuid,date) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
