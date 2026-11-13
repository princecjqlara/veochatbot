BEGIN;
CREATE TABLE veo_quota_policies(user_id uuid PRIMARY KEY REFERENCES veo_accounts(user_id),carry_enabled boolean NOT NULL DEFAULT true,max_carry integer NOT NULL DEFAULT 10 CHECK(max_carry BETWEEN 0 AND 100),capacity_multiplier numeric NOT NULL DEFAULT 2 CHECK(capacity_multiplier BETWEEN 1 AND 3),fallback_cpa_minor bigint NOT NULL DEFAULT 10000 CHECK(fallback_cpa_minor BETWEEN 100 AND 100000000),effective_from date NOT NULL DEFAULT veo_today(),updated_by uuid REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE veo_quota_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON veo_quota_policies FROM PUBLIC,anon,authenticated;GRANT ALL ON veo_quota_policies TO service_role;
INSERT INTO veo_quota_policies(user_id) SELECT user_id FROM veo_accounts WHERE role IN('member','manager');

CREATE FUNCTION veo_quota_policy(p_actor uuid,p_worker uuid,p_data jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a veo_accounts;before jsonb;BEGIN
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;
 IF a.user_id IS NULL OR NOT EXISTS(SELECT 1 FROM users WHERE id=p_actor AND is_active) OR p_worker NOT IN(SELECT veo_branch(p_actor)) OR NOT EXISTS(SELECT 1 FROM veo_accounts WHERE user_id=p_worker AND tenant_id=a.tenant_id AND role IN('member','manager')) THEN RAISE EXCEPTION 'Quota policy outside your branch' USING ERRCODE='42501';END IF;
 IF p_data IS NOT NULL THEN
  IF a.role NOT IN('owner','manager','team_leader') THEN RAISE EXCEPTION 'Supervisor access required' USING ERRCODE='42501';END IF;
  IF jsonb_typeof(p_data->'carry_enabled')<>'boolean' OR p_data->>'max_carry' IS NULL OR p_data->>'capacity_multiplier' IS NULL OR p_data->>'fallback_cpa_minor' IS NULL THEN RAISE EXCEPTION 'Choose valid quota settings';END IF;
  SELECT to_jsonb(q) INTO before FROM veo_quota_policies q WHERE user_id=p_worker;
  INSERT INTO veo_quota_policies(user_id,carry_enabled,max_carry,capacity_multiplier,fallback_cpa_minor,updated_by) VALUES(p_worker,(p_data->>'carry_enabled')::boolean,(p_data->>'max_carry')::integer,(p_data->>'capacity_multiplier')::numeric,(p_data->>'fallback_cpa_minor')::bigint,p_actor)
  ON CONFLICT(user_id) DO UPDATE SET carry_enabled=excluded.carry_enabled,max_carry=excluded.max_carry,capacity_multiplier=excluded.capacity_multiplier,fallback_cpa_minor=excluded.fallback_cpa_minor,updated_by=p_actor,updated_at=now();
  INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value) VALUES(a.tenant_id,p_actor,'quota_policy',p_worker,before,p_data);
 END IF;
 RETURN coalesce((SELECT to_jsonb(q) FROM veo_quota_policies q WHERE user_id=p_worker),jsonb_build_object('user_id',p_worker,'carry_enabled',true,'max_carry',10,'capacity_multiplier',2,'fallback_cpa_minor',10000,'effective_from',veo_today()));
END $$;

ALTER FUNCTION veo_supply_target(uuid,date,integer) RENAME TO veo_supply_target_before_flexible;
CREATE FUNCTION veo_supply_target(p_user uuid,p_day date,p_capacity integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE policy jsonb;pg uuid;s record;spend numeric;history_spend numeric;payers integer;share integer;cpa numeric;budget numeric;known boolean:=true;support integer:=0;backlog integer;available integer;base integer;carry integer:=0;applied integer:=0;previous integer;cd integer;dd integer;deferred integer:=0;result integer;details jsonb:='[]';mode text;lookback_from date;lookback_to date;history_rows integer;history_complete boolean;BEGIN
 policy:=coalesce((SELECT to_jsonb(q) FROM veo_quota_policies q WHERE user_id=p_user),jsonb_build_object('carry_enabled',true,'max_carry',10,'capacity_multiplier',2,'fallback_cpa_minor',10000,'effective_from',veo_today()));
 lookback_from:=greatest(p_day-14,(SELECT (t.launch_at AT TIME ZONE 'Asia/Manila')::date FROM veo_accounts a JOIN veo_tenants t ON t.id=a.tenant_id WHERE a.user_id=p_user));lookback_to:=least(p_day,veo_today())-1;
 SELECT count(DISTINCT contact_id)::int INTO backlog FROM veo_order_facts WHERE seller_id=p_user AND paid_minor>0 AND done_at IS NULL AND veo_can_page(p_user,page_id);
 FOR pg IN SELECT id FROM pages WHERE veo_enabled AND veo_can_page(p_user,id) LOOP
  spend:=NULL;budget:=NULL;
  IF p_day=veo_today() THEN
   SELECT CASE WHEN bool_and(coalesce((r->>'complete')::boolean,false) OR coalesce((r->>'provisional')::boolean,false)) AND count(DISTINCT r->>'currency')=1 THEN sum((r->>'amount_minor')::numeric) END AS amount,min(r->>'currency') currency INTO s FROM jsonb_array_elements(veo_calendar_spend(ARRAY[pg],p_day,p_day)) r;
   spend:=s.amount;
  ELSE
   SELECT CASE WHEN bool_and(checked_at>=now()-interval '3 hours') AND count(DISTINCT currency)=1 AND count(*)=count(allocated_daily_budget_minor) THEN sum(CASE WHEN active_ads=0 THEN 0 ELSE allocated_daily_budget_minor END) END AS amount,min(currency) currency INTO s FROM veo_ad_planning_state WHERE page_id=pg;
   budget:=s.amount;spend:=budget;
  END IF;
  IF spend IS NULL THEN known:=false;details:=details||jsonb_build_object('page_id',pg,'state','unknown');CONTINUE;END IF;
  SELECT count(*)::int,count(*)=lookback_to-lookback_from+1 AND bool_and((r->>'complete')::boolean),sum((r->>'amount_minor')::numeric) INTO history_rows,history_complete,history_spend FROM jsonb_array_elements(veo_calendar_spend(ARRAY[pg],lookback_from,lookback_to)) r WHERE r->>'currency'=s.currency;
  IF NOT coalesce(history_complete,false) THEN history_spend:=NULL;END IF;
  SELECT count(DISTINCT contact_id)::int INTO payers FROM veo_order_facts WHERE page_id=pg AND currency=s.currency AND closed_date BETWEEN lookback_from AND lookback_to AND paid_minor>0;
  cpa:=CASE WHEN history_rows>0 AND NOT coalesce(history_complete,false) THEN NULL WHEN history_spend>0 AND payers>0 THEN history_spend/payers WHEN s.currency='PHP' THEN (policy->>'fallback_cpa_minor')::numeric END;
  SELECT greatest(1,count(*))::int INTO share FROM veo_accounts a WHERE active AND role IN('member','manager') AND veo_can_page(a.user_id,pg);
  IF spend>0 AND cpa IS NULL THEN known:=false;ELSE support:=support+CASE WHEN spend=0 THEN 0 ELSE floor(spend/cpa/share)::integer END;END IF;
  details:=details||jsonb_build_object('page_id',pg,'state',CASE WHEN spend=0 THEN 'no_spend' ELSE 'funded' END,'spend_minor',spend,'currency',s.currency,'cpa_minor',cpa,'observed_cpa_minor',CASE WHEN history_spend>0 AND payers>0 THEN cpa END,'cpa_estimated',NOT coalesce(history_spend>0 AND payers>0,false),'workers_sharing_page',share);
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pages WHERE veo_enabled AND veo_can_page(p_user,id)) THEN known:=false;END IF;
 SELECT count(*) FILTER(WHERE closed_date=p_day)::int,count(*) FILTER(WHERE done_date=p_day)::int INTO cd,dd FROM veo_order_facts WHERE seller_id=p_user;
 available:=greatest(backlog+support,least(cd,dd));base:=CASE WHEN known THEN least(p_capacity,available) ELSE p_capacity END;
 IF (policy->>'carry_enabled')::boolean AND p_day-1>=(policy->>'effective_from')::date THEN
  SELECT quota,coalesce((basis->>'carry_deferred')::int,0) INTO previous,deferred FROM veo_operating_quotas WHERE user_id=p_user AND work_date=p_day-1;
  IF previous IS NOT NULL THEN
   SELECT count(*) FILTER(WHERE closed_date=p_day-1)::int,count(*) FILTER(WHERE done_date=p_day-1)::int INTO cd,dd FROM veo_order_facts WHERE seller_id=p_user;
   carry:=least((policy->>'max_carry')::int,greatest(0,previous-least(cd,dd))+coalesce(deferred,0));
  END IF;
 END IF;
 applied:=CASE WHEN known THEN least(carry,greatest(0,available-base),greatest(0,ceil(p_capacity*(policy->>'capacity_multiplier')::numeric)::int-base)) ELSE 0 END;
 result:=base+applied;mode:=CASE WHEN NOT known THEN 'unknown' WHEN support=0 THEN 'no_spend' ELSE 'spend_funded' END;
 RETURN jsonb_build_object('capacity',p_capacity,'quota',result,'base_quota',base,'supply_known',known,'ad_mode',mode,'open_paid_clients',backlog,'funded_new_clients',support,'carry_remaining',carry,'carry_applied',applied,'carry_deferred',carry-applied,'pages',details,'policy',policy,'provisional',p_day>=veo_today(),'formula','min(capacity, funded clients + existing paid work) + carryover, limited by available work and capacity multiplier. Unknown spend keeps capacity; unfunded carryover is deferred.');
END $$;

-- Current-day targets may follow actual spend. Completed-day records stay frozen.
DROP TRIGGER veo_operating_quota_readonly ON veo_operating_quotas;
CREATE FUNCTION veo_protect_past_quota() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.work_date<veo_today() THEN RAISE EXCEPTION 'Completed-day quota is read-only';END IF;RETURN NEW;END $$;
CREATE TRIGGER veo_operating_quota_readonly BEFORE UPDATE OR DELETE ON veo_operating_quotas FOR EACH ROW EXECUTE FUNCTION veo_protect_past_quota();
ALTER FUNCTION veo_target(uuid,date) RENAME TO veo_target_before_flexible;
CREATE FUNCTION veo_target(p_user uuid,p_day date) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE capacity jsonb;q jsonb;previous integer;result integer;BEGIN
 IF p_day<veo_today() THEN RETURN veo_target_before_flexible(p_user,p_day);END IF;
 INSERT INTO veo_quota_policies(user_id) SELECT user_id FROM veo_accounts WHERE user_id=p_user AND role IN('member','manager') ON CONFLICT DO NOTHING;
 capacity:=veo_capacity(p_user,p_day);q:=veo_supply_target(p_user,p_day,(capacity->>'target')::int);result:=greatest(1,(q->>'quota')::int);
 IF p_day>veo_today() THEN RETURN result;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_user::text||':'||p_day,0));
 SELECT quota INTO previous FROM veo_operating_quotas WHERE user_id=p_user AND work_date=p_day;
 INSERT INTO veo_operating_quotas(user_id,work_date,capacity,quota,basis) VALUES(p_user,p_day,(capacity->>'target')::int,(q->>'quota')::int,q) ON CONFLICT(user_id,work_date) DO UPDATE SET capacity=excluded.capacity,quota=excluded.quota,basis=excluded.basis WHERE veo_operating_quotas.basis IS DISTINCT FROM excluded.basis;
 INSERT INTO veo_daily_targets VALUES(p_user,p_day,result,capacity||jsonb_build_object('operating',q),now()) ON CONFLICT(user_id,work_date) DO UPDATE SET target=excluded.target,basis=excluded.basis WHERE veo_daily_targets.basis IS DISTINCT FROM excluded.basis;
 IF previous IS DISTINCT FROM (q->>'quota')::int THEN INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value,reason) SELECT tenant_id,p_user,'spend_quota_update',p_user,jsonb_build_object('quota',previous),q,'Provisional quota follows recorded ad spend and available work' FROM veo_accounts WHERE user_id=p_user;END IF;
 RETURN result;
END $$;
CREATE FUNCTION veo_refresh_spend_quotas() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE worker uuid;n integer:=0;BEGIN FOR worker IN SELECT user_id FROM veo_accounts WHERE active AND role IN('member','manager') LOOP PERFORM veo_target(worker,veo_today());n:=n+1;END LOOP;RETURN jsonb_build_object('workers',n,'work_date',veo_today());END $$;

CREATE OR REPLACE FUNCTION veo_operating_quota(p_user uuid,p_day date) RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN p_day>=veo_today() THEN (veo_supply_target(p_user,p_day,(veo_capacity(p_user,p_day)->>'target')::int)->>'quota')::int ELSE coalesce((SELECT quota FROM veo_operating_quotas WHERE user_id=p_user AND work_date=p_day),(SELECT target FROM veo_daily_targets WHERE user_id=p_user AND work_date=p_day),(veo_capacity(p_user,p_day)->>'target')::int) END
$$;

DO $$ DECLARE definition text;BEGIN
 definition:=pg_get_functiondef('veo_incentive_notice(uuid)'::regprocedure);
 definition:=replace(definition,'VEO · DEAL INCENTIVE','Deal incentive update');
 definition:=replace(definition,'Replaces any earlier incentive for this order. Applies to verified paid principal when eligible for salary; tips excluded.','Extra commission on verified paid principal, when eligible for salary. Tips excluded. This replaces the previous incentive on this deal.');
 EXECUTE definition;
END $$;

-- A successful current-day source check is usable provisionally, never final.
DO $$ DECLARE definition text;BEGIN
 definition:=pg_get_functiondef('veo_calendar_spend(uuid[],date,date)'::regprocedure);
 definition:=replace(definition,'AS complete,','AS complete, coalesce(k.spend_date=veo_today() AND c.pht_aligned AND c.checked_at>=now()-interval ''3 hours'' AND c.checked_at>=coalesce(r.checked_at,''-infinity'') AND coalesce(r.records,0)=coalesce(r.ads,0) AND coalesce(r.ads,0)=c.ad_count AND coalesce(r.amount_minor,0)=c.amount_minor,false) AS provisional,');
 EXECUTE definition;
END $$;
DO $$ DECLARE f record;BEGIN FOR f IN SELECT oid::regprocedure sig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_refresh_spend_quotas','veo_quota_policy','veo_supply_target','veo_supply_target_before_flexible','veo_target','veo_target_before_flexible','veo_operating_quota','veo_protect_past_quota') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.sig);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.sig);END LOOP;END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
