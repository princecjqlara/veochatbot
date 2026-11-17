BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE TABLE veo_discipline_policies(
 supervisor_id uuid PRIMARY KEY REFERENCES veo_accounts(user_id),
 warning_limit integer NOT NULL DEFAULT 3 CHECK(warning_limit BETWEEN 1 AND 100),
 auto_suspend boolean NOT NULL DEFAULT false,
 suspension_minutes integer CHECK(suspension_minutes BETWEEN 1 AND 525600),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE veo_member_suspensions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),request_id uuid NOT NULL UNIQUE,
 tenant_id uuid NOT NULL REFERENCES veo_tenants(id),user_id uuid NOT NULL REFERENCES veo_accounts(user_id),
 imposed_by uuid NOT NULL REFERENCES users(id),source text NOT NULL CHECK(source IN('manual','warnings')),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 500),
 starts_at timestamptz NOT NULL DEFAULT clock_timestamp(),ends_at timestamptz,
 duration_minutes integer CHECK(duration_minutes BETWEEN 1 AND 525600),
 lifted_at timestamptz,lifted_by uuid REFERENCES users(id),lift_reason text,
 CHECK(ends_at IS NULL OR ends_at>starts_at)
);
CREATE UNIQUE INDEX veo_member_suspension_open ON veo_member_suspensions(user_id) WHERE lifted_at IS NULL;
CREATE TABLE veo_staff_warning_records(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),request_id uuid UNIQUE,
 tenant_id uuid NOT NULL REFERENCES veo_tenants(id),user_id uuid NOT NULL REFERENCES veo_accounts(user_id),
 source_key text NOT NULL CHECK(length(source_key) BETWEEN 1 AND 300),detail jsonb NOT NULL,
 issued_by uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 removed_at timestamptz,removed_by uuid REFERENCES users(id),removal_reason text,
 counted_suspension_id uuid REFERENCES veo_member_suspensions(id),UNIQUE(user_id,source_key)
);
CREATE INDEX veo_staff_warning_current ON veo_staff_warning_records(user_id) WHERE removed_at IS NULL AND counted_suspension_id IS NULL;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['veo_discipline_policies','veo_member_suspensions','veo_staff_warning_records'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,anon,authenticated',t);
 EXECUTE format('GRANT ALL ON %I TO service_role',t);
END LOOP;END $$;

CREATE FUNCTION veo_member_suspension(p_user uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('id',s.id,'reason',s.reason,'starts_at',s.starts_at,'ends_at',s.ends_at,'source',s.source)
 FROM veo_member_suspensions s JOIN veo_accounts a ON a.user_id=s.user_id AND a.role='member'
 WHERE s.user_id=p_user AND s.lifted_at IS NULL AND(s.ends_at IS NULL OR s.ends_at>statement_timestamp())
$$;
CREATE FUNCTION veo_discipline_supervisor(p_actor uuid,p_user uuid DEFAULT NULL) RETURNS veo_accounts
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a veo_accounts;BEGIN
 SELECT x.* INTO a FROM veo_accounts x JOIN users u ON u.id=x.user_id AND u.is_active WHERE x.user_id=p_actor AND x.active AND x.departed_at IS NULL;
 IF a.user_id IS NULL OR a.role NOT IN('owner','team_leader','manager') THEN RAISE EXCEPTION 'Manager or Team Leader access required' USING ERRCODE='42501';END IF;
 IF p_user IS NOT NULL AND NOT EXISTS(SELECT 1 FROM veo_accounts w WHERE w.user_id=p_user AND w.tenant_id=a.tenant_id
  AND w.role='member' AND w.active AND w.departed_at IS NULL AND w.user_id IN(SELECT veo_descendants(p_actor))) THEN
  RAISE EXCEPTION 'Choose an active member in your branch. Supervisors are exempt.' USING ERRCODE='42501';END IF;
 RETURN a;
END $$;
CREATE FUNCTION veo_member_discipline_policy(p_user uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT to_jsonb(p)||jsonb_build_object('supervisor_name',u.name)
 FROM veo_discipline_policies p JOIN veo_accounts a ON a.user_id=p.supervisor_id AND a.active AND a.departed_at IS NULL
 JOIN users u ON u.id=a.user_id AND u.is_active JOIN veo_accounts w ON w.user_id=p_user AND w.tenant_id=a.tenant_id
 WHERE a.role IN('owner','team_leader','manager') AND w.role='member' AND w.user_id IN(SELECT veo_descendants(a.user_id))
 ORDER BY (a.user_id=w.parent_id) DESC,CASE a.role WHEN 'manager' THEN 0 WHEN 'team_leader' THEN 1 ELSE 2 END,a.user_id LIMIT 1),
 jsonb_build_object('supervisor_id',NULL,'warning_limit',3,'auto_suspend',false,'suspension_minutes',NULL))
$$;
CREATE FUNCTION veo_suspend_member(p_actor uuid,p_user uuid,p_reason text,p_minutes integer,p_source text,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a veo_accounts;s veo_member_suspensions;warning jsonb;BEGIN
 a:=veo_discipline_supervisor(p_actor,p_user);
 IF p_request IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500 OR p_source NOT IN('manual','warnings')
 OR p_minutes IS NOT NULL AND p_minutes NOT BETWEEN 1 AND 525600 THEN RAISE EXCEPTION 'Enter a reason and a valid suspension duration';END IF;
 PERFORM 1 FROM veo_accounts WHERE user_id=p_user FOR UPDATE;
 SELECT * INTO s FROM veo_member_suspensions WHERE request_id=p_request;
 IF s.id IS NOT NULL THEN
  IF(s.user_id,s.imposed_by,s.reason,s.source,s.duration_minutes) IS DISTINCT FROM(p_user,p_actor,btrim(p_reason),p_source,p_minutes) THEN RAISE EXCEPTION 'Suspension request already used' USING ERRCODE='23505';END IF;
  RETURN to_jsonb(s)||jsonb_build_object('duplicate',true);
 END IF;
 IF veo_member_suspension(p_user) IS NOT NULL THEN RAISE EXCEPTION 'This member is already suspended. Refresh their status.' USING ERRCODE='40001';END IF;
 UPDATE veo_member_suspensions SET lifted_at=ends_at,lift_reason='Timed suspension expired' WHERE user_id=p_user AND lifted_at IS NULL AND ends_at<=clock_timestamp();
 IF p_source='manual' THEN
  FOR warning IN SELECT w.value FROM jsonb_array_elements(veo_workflow_warnings_before_discipline(p_actor,p_user)->'workers') person
   CROSS JOIN LATERAL jsonb_array_elements(person.value->'warnings') w WHERE person.value->>'id'=p_user::text AND w.value->>'severity'='warning' LOOP
   INSERT INTO veo_staff_warning_records(tenant_id,user_id,source_key,detail) VALUES(a.tenant_id,p_user,warning->>'key',warning) ON CONFLICT(user_id,source_key) DO NOTHING;
  END LOOP;
 END IF;
 INSERT INTO veo_member_suspensions(request_id,tenant_id,user_id,imposed_by,source,reason,ends_at,duration_minutes)
 VALUES(p_request,a.tenant_id,p_user,p_actor,p_source,btrim(p_reason),CASE WHEN p_minutes IS NOT NULL THEN clock_timestamp()+make_interval(mins=>p_minutes) END,p_minutes) RETURNING * INTO s;
 UPDATE veo_staff_warning_records SET counted_suspension_id=s.id WHERE user_id=p_user AND removed_at IS NULL AND counted_suspension_id IS NULL;
 UPDATE veo_intake_readiness SET status='busy',expires_at=clock_timestamp(),updated_at=clock_timestamp() WHERE user_id=p_user;
 UPDATE veo_client_offers SET status='cancelled',ended_at=clock_timestamp(),reason='Member suspended' WHERE offered_to=p_user AND status='pending';
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value,reason) VALUES(a.tenant_id,p_actor,'member_suspended',p_user,to_jsonb(s),btrim(p_reason));
 RETURN to_jsonb(s)||jsonb_build_object('duplicate',false);
END $$;
CREATE FUNCTION veo_enforce_member_discipline(p_user uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE policy jsonb;n integer;BEGIN
 PERFORM 1 FROM veo_accounts WHERE user_id=p_user AND role='member' AND active AND departed_at IS NULL FOR UPDATE;
 IF NOT FOUND OR veo_member_suspension(p_user) IS NOT NULL THEN RETURN NULL;END IF;
 policy:=veo_member_discipline_policy(p_user);
 IF policy->'auto_suspend' IS DISTINCT FROM 'true'::jsonb THEN RETURN NULL;END IF;
 SELECT count(*)::int INTO n FROM veo_staff_warning_records WHERE user_id=p_user AND removed_at IS NULL AND counted_suspension_id IS NULL;
 IF n<(policy->>'warning_limit')::integer THEN RETURN NULL;END IF;
 RETURN veo_suspend_member((policy->>'supervisor_id')::uuid,p_user,'Configured warning limit reached ('||n||' warnings)',(policy->>'suspension_minutes')::integer,'warnings',gen_random_uuid());
END $$;

ALTER FUNCTION veo_workflow_warnings(uuid,uuid) RENAME TO veo_workflow_warnings_before_discipline;
CREATE FUNCTION veo_refresh_discipline(p_actor uuid,p_worker uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off SET lock_timeout='1s' AS $$
DECLARE a veo_accounts;raw jsonb;person jsonb;w jsonb;added integer:=0;suspended integer:=0;n integer;BEGIN
 a:=veo_discipline_supervisor(p_actor,p_worker);
 IF NOT pg_try_advisory_xact_lock(hashtextextended('veo-discipline:'||p_actor,0)) THEN RETURN jsonb_build_object('skipped',true);END IF;
 raw:=veo_workflow_warnings_before_discipline(p_actor,p_worker);
 FOR person IN SELECT value FROM jsonb_array_elements(raw->'workers') LOOP
  IF person->>'role'<>'member' OR person->'active' IS DISTINCT FROM 'true'::jsonb OR veo_member_suspension((person->>'id')::uuid) IS NOT NULL THEN CONTINUE;END IF;
  PERFORM 1 FROM veo_accounts WHERE user_id=(person->>'id')::uuid FOR UPDATE;
  FOR w IN SELECT value FROM jsonb_array_elements(person->'warnings') WHERE value->>'severity'='warning' LOOP
   INSERT INTO veo_staff_warning_records(tenant_id,user_id,source_key,detail)
   VALUES(a.tenant_id,(person->>'id')::uuid,w->>'key',w) ON CONFLICT(user_id,source_key) DO NOTHING;
   GET DIAGNOSTICS n=ROW_COUNT;added:=added+n;
  END LOOP;
  IF veo_enforce_member_discipline((person->>'id')::uuid) IS NOT NULL THEN suspended:=suspended+1;END IF;
 END LOOP;
 RETURN jsonb_build_object('recorded',added,'suspended',suspended);
END $$;
CREATE FUNCTION veo_refresh_all_discipline() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE a record;results jsonb:='[]';BEGIN
 FOR a IN SELECT owner.user_id FROM veo_accounts owner JOIN users u ON u.id=owner.user_id AND u.is_active
 WHERE owner.role='owner' AND owner.active AND EXISTS(SELECT 1 FROM veo_discipline_policies p JOIN veo_accounts supervisor ON supervisor.user_id=p.supervisor_id
 WHERE supervisor.tenant_id=owner.tenant_id AND supervisor.active AND p.auto_suspend) ORDER BY owner.user_id LIMIT 5 LOOP
  results:=results||jsonb_build_array(veo_refresh_discipline(a.user_id,NULL));
 END LOOP;
 RETURN jsonb_build_object('tenants',results);
END $$;

CREATE FUNCTION veo_discipline_action(p_actor uuid,p_action text,p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off SET lock_timeout='2s' AS $$
DECLARE a veo_accounts;target uuid;change_reason text;w veo_staff_warning_records;s veo_member_suspensions;detail jsonb;policy jsonb;result jsonb;BEGIN
 target:=nullif(p_data->>'user_id','')::uuid;change_reason:=btrim(p_data->>'reason');
 a:=veo_discipline_supervisor(p_actor,CASE WHEN p_action='policy' THEN NULL ELSE target END);
 IF p_action='policy' THEN
  IF jsonb_typeof(p_data->'auto_suspend') IS DISTINCT FROM 'boolean' OR (p_data->>'warning_limit')::integer NOT BETWEEN 1 AND 100
  OR p_data->>'warning_limit' IS NULL OR (p_data->>'suspension_minutes')::integer NOT BETWEEN 1 AND 525600 THEN RAISE EXCEPTION 'Choose a warning limit and suspension duration';END IF;
  INSERT INTO veo_discipline_policies(supervisor_id,warning_limit,auto_suspend,suspension_minutes)
  VALUES(p_actor,(p_data->>'warning_limit')::integer,(p_data->>'auto_suspend')::boolean,(p_data->>'suspension_minutes')::integer)
  ON CONFLICT(supervisor_id) DO UPDATE SET warning_limit=EXCLUDED.warning_limit,auto_suspend=EXCLUDED.auto_suspend,suspension_minutes=EXCLUDED.suspension_minutes,updated_at=clock_timestamp();
  SELECT to_jsonb(p) INTO policy FROM veo_discipline_policies p WHERE supervisor_id=p_actor;
  INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value,reason) VALUES(a.tenant_id,p_actor,'discipline_policy_changed',p_actor,policy,'Supervisor configured member warning and suspension policy');
  result:=veo_refresh_discipline(p_actor,NULL);
  RETURN jsonb_build_object('policy',policy,'refresh',result);
 END IF;
 IF target IS NULL OR change_reason IS NULL OR length(change_reason) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'Choose a member and enter a reason of 3 to 500 characters';END IF;
 PERFORM 1 FROM veo_accounts WHERE user_id=target FOR UPDATE;
 IF p_action='suspend' THEN
  RETURN jsonb_build_object('suspension',veo_suspend_member(p_actor,target,change_reason,(p_data->>'duration_minutes')::integer,'manual',(p_data->>'request_id')::uuid));
 ELSIF p_action='lift' THEN
  SELECT * INTO s FROM veo_member_suspensions WHERE id=(p_data->>'suspension_id')::uuid AND user_id=target FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Suspension changed. Refresh this member.' USING ERRCODE='40001';END IF;
  IF s.lifted_at IS NOT NULL THEN RETURN jsonb_build_object('lifted',true,'duplicate',true);END IF;
  UPDATE veo_member_suspensions SET lifted_at=clock_timestamp(),lifted_by=p_actor,lift_reason=change_reason WHERE id=s.id;
  INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value,reason) VALUES(a.tenant_id,p_actor,'member_suspension_lifted',target,to_jsonb(s),jsonb_build_object('suspension_id',s.id,'lifted',true),change_reason);
  RETURN jsonb_build_object('lifted',true);
 ELSIF p_action='issue' THEN
  IF veo_member_suspension(target) IS NOT NULL THEN RAISE EXCEPTION 'Lift the current suspension before issuing another warning' USING ERRCODE='40001';END IF;
  IF p_data->>'request_id' IS NULL THEN RAISE EXCEPTION 'A warning request reference is required';END IF;
  SELECT * INTO w FROM veo_staff_warning_records WHERE request_id=(p_data->>'request_id')::uuid;
  IF w.id IS NOT NULL THEN
   IF w.user_id<>target OR w.issued_by<>p_actor OR w.detail->>'title'<>change_reason THEN RAISE EXCEPTION 'Warning request already used' USING ERRCODE='23505';END IF;
   RETURN jsonb_build_object('warning_id',w.id,'duplicate',true);
  END IF;
  INSERT INTO veo_staff_warning_records(request_id,tenant_id,user_id,source_key,detail,issued_by)
  VALUES((p_data->>'request_id')::uuid,a.tenant_id,target,'manual:'||(p_data->>'request_id'),jsonb_build_object('key','manual:'||(p_data->>'request_id'),'kind','manual_warning','severity','warning','title',change_reason,'created_at',clock_timestamp()),p_actor) RETURNING * INTO w;
  INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value,reason) VALUES(a.tenant_id,p_actor,'member_warning_issued',target,to_jsonb(w),change_reason);
  RETURN jsonb_build_object('warning_id',w.id,'suspension',veo_enforce_member_discipline(target));
 ELSIF p_action='remove' THEN
  IF p_data->>'source_key' IS NULL OR length(p_data->>'source_key') NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'Choose a warning';END IF;
  SELECT * INTO w FROM veo_staff_warning_records WHERE user_id=target AND source_key=p_data->>'source_key' FOR UPDATE;
  IF w.id IS NULL THEN
   SELECT warning.value INTO detail FROM jsonb_array_elements(veo_workflow_warnings_before_discipline(p_actor,target)->'workers') person
    CROSS JOIN LATERAL jsonb_array_elements(person.value->'warnings') warning
    WHERE person.value->>'id'=target::text AND warning.value->>'key'=p_data->>'source_key' AND warning.value->>'severity'='warning';
   IF detail IS NULL THEN RAISE EXCEPTION 'This warning is no longer available. Refresh the list.' USING ERRCODE='40001';END IF;
   INSERT INTO veo_staff_warning_records(tenant_id,user_id,source_key,detail) VALUES(a.tenant_id,target,p_data->>'source_key',detail) RETURNING * INTO w;
  END IF;
  IF w.removed_at IS NOT NULL THEN RETURN jsonb_build_object('removed',true,'duplicate',true);END IF;
  UPDATE veo_staff_warning_records SET removed_at=clock_timestamp(),removed_by=p_actor,removal_reason=change_reason WHERE id=w.id;
  INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value,reason) VALUES(a.tenant_id,p_actor,'member_warning_removed',target,to_jsonb(w),jsonb_build_object('warning_id',w.id,'removed',true),change_reason);
  RETURN jsonb_build_object('removed',true);
 END IF;
 RAISE EXCEPTION 'Unknown discipline action';
END $$;

CREATE FUNCTION veo_workflow_warnings(p_actor uuid,p_worker uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE raw jsonb;person jsonb;warning jsonb;record veo_staff_warning_records;warnings jsonb;people jsonb:='[]';n integer;can_manage boolean;policy jsonb;BEGIN
 IF veo_member_suspension(p_actor) IS NOT NULL THEN RAISE EXCEPTION 'Account suspended' USING ERRCODE='42501';END IF;
 raw:=veo_workflow_warnings_before_discipline(p_actor,p_worker);
 SELECT role IN('owner','team_leader','manager') AND active INTO can_manage FROM veo_accounts WHERE user_id=p_actor;
 SELECT to_jsonb(p) INTO policy FROM veo_discipline_policies p WHERE supervisor_id=p_actor;
 FOR person IN SELECT value FROM jsonb_array_elements(raw->'workers') LOOP
  warnings:='[]';n:=0;
  IF person->>'role'='member' THEN
   FOR warning IN SELECT value FROM jsonb_array_elements(person->'warnings') LOOP
    SELECT * INTO record FROM veo_staff_warning_records WHERE user_id=(person->>'id')::uuid AND source_key=warning->>'key';
    IF warning->>'severity'='warning' AND record.removed_at IS NOT NULL THEN CONTINUE;END IF;
    IF warning->>'severity'='warning' THEN
     warning:=warning||jsonb_build_object('warning_id',record.id,'counts_toward_suspension',record.counted_suspension_id IS NULL);
     IF record.counted_suspension_id IS NULL THEN n:=n+1;END IF;
    END IF;
    warnings:=warnings||jsonb_build_array(warning);
   END LOOP;
   FOR record IN SELECT r.* FROM veo_staff_warning_records r WHERE r.user_id=(person->>'id')::uuid AND r.removed_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(person->'warnings') current WHERE current.value->>'key'=r.source_key) ORDER BY r.created_at,r.id LOOP
    warning:=record.detail;
    IF warning->>'page_id' IS NOT NULL AND NOT veo_can_page(p_actor,(warning->>'page_id')::uuid) THEN
     warning:=jsonb_build_object('key',record.source_key,'kind',warning->>'kind','severity','warning','title','Recorded warning (Page access restricted)','created_at',record.created_at);
    END IF;
    warnings:=warnings||jsonb_build_array(warning||jsonb_build_object('warning_id',record.id,'counts_toward_suspension',record.counted_suspension_id IS NULL));
    IF record.counted_suspension_id IS NULL THEN n:=n+1;END IF;
   END LOOP;
  END IF;
  people:=people||jsonb_build_array(person||jsonb_build_object('warnings',warnings,'warning_count',n,'warning_immunity',person->>'role'<>'member',
   'suspension',veo_member_suspension((person->>'id')::uuid),'discipline_policy',veo_member_discipline_policy((person->>'id')::uuid)));
 END LOOP;
 RETURN raw||jsonb_build_object('workers',people,'can_manage_discipline',coalesce(can_manage,false),'discipline_policy',coalesce(policy,
  jsonb_build_object('warning_limit',3,'auto_suspend',false,'suspension_minutes',NULL)),
  'discipline_note','Recorded warnings count until removed or used for a suspension. Salary holds and setup reminders do not count. Managers and Team Leaders are exempt.');
END $$;

-- Keep salary eligibility and historical accounting intact. Restrict current
-- access rather than deactivating the account or removing its Page grants.
ALTER FUNCTION veo_scope(uuid) RENAME TO veo_scope_before_discipline;
CREATE FUNCTION veo_scope(p_actor uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN veo_member_suspension(p_actor) IS NULL THEN veo_scope_before_discipline(p_actor) END
$$;
CREATE FUNCTION veo_access_context(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE suspended jsonb;BEGIN
 suspended:=veo_member_suspension(p_actor);
 IF suspended IS NOT NULL THEN RETURN jsonb_build_object('suspension',suspended,'user_id',p_actor);END IF;
 RETURN veo_scope(p_actor);
END $$;
ALTER FUNCTION veo_login_context(text) RENAME TO veo_login_context_before_discipline;
CREATE FUNCTION veo_login_context(p_email text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;suspended jsonb;BEGIN
 result:=veo_login_context_before_discipline(p_email);
 IF result->>'id' IS NOT NULL THEN suspended:=veo_member_suspension((result->>'id')::uuid);END IF;
 IF suspended IS NOT NULL THEN result:=result||jsonb_build_object('suspension',suspended);END IF;
 RETURN result;
END $$;
ALTER FUNCTION veo_authorize_resources(uuid,jsonb) RENAME TO veo_authorize_resources_before_discipline;
CREATE FUNCTION veo_authorize_resources(p_actor uuid,p_refs jsonb) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT veo_member_suspension(p_actor) IS NULL AND veo_authorize_resources_before_discipline(p_actor,p_refs)
$$;
ALTER FUNCTION veo_telegram_intake_context(uuid,bigint,bigint) RENAME TO veo_telegram_intake_context_before_discipline;
CREATE FUNCTION veo_telegram_intake_context(p_tenant uuid,p_telegram bigint,p_chat bigint) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;BEGIN
 result:=veo_telegram_intake_context_before_discipline(p_tenant,p_telegram,p_chat);
 IF veo_member_suspension((result->>'actor_id')::uuid) IS NOT NULL THEN RAISE EXCEPTION 'Account suspended. Ask your Manager or Team Leader.' USING ERRCODE='42501';END IF;
 RETURN result;
END $$;
ALTER FUNCTION veo_action(uuid,text,jsonb) RENAME TO veo_action_before_discipline;
CREATE FUNCTION veo_action(p_actor uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF veo_member_suspension(p_actor) IS NOT NULL THEN RAISE EXCEPTION 'Account suspended' USING ERRCODE='42501';END IF;
 RETURN veo_action_before_discipline(p_actor,p_action,p_data);
END $$;
ALTER FUNCTION veo_intake_action(uuid,text,jsonb) RENAME TO veo_intake_action_before_discipline;
CREATE FUNCTION veo_intake_action(p_actor uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF veo_member_suspension(p_actor) IS NOT NULL THEN RAISE EXCEPTION 'Account suspended' USING ERRCODE='42501';END IF;
 RETURN veo_intake_action_before_discipline(p_actor,p_action,p_data);
END $$;
ALTER FUNCTION veo_deal_review_context(uuid,uuid,uuid) RENAME TO veo_deal_review_context_before_discipline;
CREATE FUNCTION veo_deal_review_context(p_actor uuid,p_contact uuid,p_seller uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF veo_member_suspension(p_actor) IS NOT NULL THEN RAISE EXCEPTION 'Account suspended' USING ERRCODE='42501';END IF;
 RETURN veo_deal_review_context_before_discipline(p_actor,p_contact,p_seller);
END $$;
ALTER FUNCTION veo_intake_recipient(uuid,uuid,uuid) RENAME TO veo_intake_recipient_before_discipline;
CREATE FUNCTION veo_intake_recipient(p_actor uuid,p_worker uuid,p_page uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT veo_member_suspension(p_actor) IS NULL AND veo_member_suspension(p_worker) IS NULL AND veo_intake_recipient_before_discipline(p_actor,p_worker,p_page)
$$;
ALTER FUNCTION veo_dispatch_editor_allowed(uuid,uuid,uuid,bigint,timestamptz) RENAME TO veo_dispatch_editor_allowed_before_discipline;
CREATE FUNCTION veo_dispatch_editor_allowed(p_user uuid,p_team uuid,p_page uuid,p_chat bigint,p_now timestamptz) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT veo_member_suspension(p_user) IS NULL AND veo_dispatch_editor_allowed_before_discipline(p_user,p_team,p_page,p_chat,p_now)
$$;
ALTER FUNCTION veo_send_allowed(text,uuid,uuid) RENAME TO veo_send_allowed_before_discipline;
CREATE FUNCTION veo_send_allowed(p_fb_page text,p_actor uuid DEFAULT NULL,p_campaign uuid DEFAULT NULL) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT(p_actor IS NULL OR veo_member_suspension(p_actor) IS NULL)
 AND(p_campaign IS NULL OR NOT EXISTS(SELECT 1 FROM campaigns c WHERE c.id=p_campaign AND veo_member_suspension(c.created_by) IS NOT NULL))
 AND veo_send_allowed_before_discipline(p_fb_page,p_actor,p_campaign)
$$;
DO $$ DECLARE f record;BEGIN FOR f IN SELECT oid::regprocedure sig FROM pg_proc WHERE pronamespace='public'::regnamespace AND
 (proname IN('veo_member_suspension','veo_discipline_supervisor','veo_member_discipline_policy','veo_suspend_member','veo_enforce_member_discipline',
 'veo_refresh_discipline','veo_refresh_all_discipline','veo_discipline_action','veo_workflow_warnings','veo_workflow_warnings_before_discipline',
 'veo_scope','veo_scope_before_discipline','veo_access_context','veo_login_context','veo_login_context_before_discipline',
 'veo_authorize_resources','veo_authorize_resources_before_discipline','veo_telegram_intake_context','veo_telegram_intake_context_before_discipline',
 'veo_action','veo_action_before_discipline','veo_intake_action','veo_intake_action_before_discipline',
 'veo_deal_review_context','veo_deal_review_context_before_discipline','veo_intake_recipient','veo_intake_recipient_before_discipline',
 'veo_dispatch_editor_allowed','veo_dispatch_editor_allowed_before_discipline','veo_send_allowed','veo_send_allowed_before_discipline')) LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.sig);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.sig);
END LOOP;END $$;
INSERT INTO app_private.schema_migrations(version,description) VALUES('202611170004','Scoped member warnings, configurable automatic and manual suspension, timed expiry and immediate session restrictions') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
