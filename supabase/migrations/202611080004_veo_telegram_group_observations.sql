BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL jit=off;
ALTER FUNCTION veo_map_staff_telegram(uuid,uuid,bigint,bigint) RENAME TO veo_map_staff_telegram_before_groups;
CREATE FUNCTION veo_map_staff_telegram(p_actor uuid,p_user uuid,p_telegram bigint,p_chat bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;tenant uuid;BEGIN
 SELECT tenant_id INTO tenant FROM veo_accounts WHERE user_id=p_actor AND active AND role='owner';
 IF tenant IS NULL THEN RAISE EXCEPTION 'Owner access required' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('veo-telegram-groups:'||tenant::text,0));
 IF EXISTS(SELECT 1 FROM veo_worker_mappings m JOIN veo_accounts a USING(user_id) WHERE a.tenant_id=tenant AND a.active AND m.telegram_user_id=p_telegram AND m.user_id<>p_user) THEN RAISE EXCEPTION 'Telegram identity already belongs to another active account' USING ERRCODE='23505';END IF;
 IF EXISTS(SELECT 1 FROM veo_telegram_memberships WHERE user_id=p_user AND telegram_user_id<>p_telegram) THEN RAISE EXCEPTION 'Remove existing group memberships before changing Telegram identity';END IF;
 result:=veo_map_staff_telegram_before_groups(p_actor,p_user,p_telegram,p_chat);
 IF veo_staff_can_telegram_group(p_user,p_chat) THEN
  INSERT INTO veo_telegram_memberships VALUES(p_user,tenant,p_chat,p_telegram,clock_timestamp(),p_actor) ON CONFLICT(user_id,chat_id) DO UPDATE SET telegram_user_id=p_telegram,verified_at=clock_timestamp(),verified_by=p_actor;
 END IF;
 RETURN result;
END $$;
ALTER FUNCTION veo_action(uuid,text,jsonb) RENAME TO veo_action_before_group_controls;
CREATE FUNCTION veo_action(p_actor uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_action='mapping' AND EXISTS(SELECT 1 FROM veo_teams WHERE id=nullif(p_data->>'team_id','')::uuid AND telegram_groups_managed) THEN RAISE EXCEPTION 'Use Telegram Groups and Pages to edit a team with multiple destinations';END IF;
 RETURN veo_action_before_group_controls(p_actor,p_action,p_data);
END $$;
ALTER FUNCTION veo_current_telegram_group(uuid) RENAME TO veo_current_telegram_group_before_groups;
CREATE FUNCTION veo_current_telegram_group(p_user uuid) RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE chat bigint;BEGIN
 SELECT m.chat_id INTO chat FROM veo_telegram_memberships m LEFT JOIN veo_staff_telegram_groups s ON s.user_id=m.user_id
 WHERE m.user_id=p_user AND veo_staff_can_telegram_group(p_user,m.chat_id)
 ORDER BY (m.chat_id=s.telegram_chat_id) DESC NULLS LAST,m.verified_at,m.chat_id LIMIT 1;
 IF FOUND THEN RETURN chat;END IF;
 IF EXISTS(SELECT 1 FROM veo_accounts a JOIN veo_teams t ON t.manager_id=CASE WHEN a.role='manager' THEN a.user_id ELSE a.parent_id END WHERE a.user_id=p_user AND t.telegram_groups_managed) THEN RETURN NULL;END IF;
 RETURN veo_current_telegram_group_before_groups(p_user);
END $$;
ALTER FUNCTION veo_apply_telegram_observations(uuid,jsonb) RENAME TO veo_apply_telegram_observations_before_groups;
CREATE FUNCTION veo_apply_telegram_observations(p_tenant uuid,p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE person jsonb;a veo_accounts;owner uuid;chat bigint;seen timestamptz;prior jsonb;info jsonb;answer jsonb;poll jsonb;current_state jsonb;legacy jsonb;
 checked integer:=0;imported integer:=0;removed integer:=0;all_count integer;left_count integer;state_seen timestamptz;primary_chat bigint;BEGIN
 SELECT owner_id INTO owner FROM veo_tenants WHERE id=p_tenant AND launch_at IS NOT NULL;
 IF owner IS NULL OR p_payload->>'tenant_id' IS DISTINCT FROM p_tenant::text OR jsonb_typeof(p_payload->'workers') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'workers')>5000 THEN RAISE EXCEPTION 'Invalid connected workforce';END IF;
 FOR person IN SELECT value FROM jsonb_array_elements(p_payload->'workers') LOOP
  SELECT * INTO a FROM veo_accounts WHERE user_id=(person->>'user_id')::uuid AND tenant_id=p_tenant AND active AND role<>'owner' FOR UPDATE;
  IF NOT FOUND THEN CONTINUE;END IF;
  IF NOT EXISTS(SELECT 1 FROM veo_telegram_memberships WHERE user_id=a.user_id) THEN
   legacy:=veo_apply_telegram_observations_before_groups(p_tenant,jsonb_build_object('tenant_id',p_tenant,'workers',jsonb_build_array(person)));
   checked:=checked+coalesce((legacy->>'checked')::int,0);imported:=imported+coalesce((legacy->>'attendance_imported')::int,0);removed:=removed+coalesce((legacy->>'departures')::int,0);CONTINUE;
  END IF;
  chat:=(person->>'chat_id')::bigint;seen:=(person->>'observed_at')::timestamptz;
  IF seen IS NULL OR seen<now()-interval '10 minutes' OR seen>now()+interval '1 minute' OR length(person::text)>12000 OR NOT veo_staff_can_telegram_group(a.user_id,chat)
   OR NOT EXISTS(SELECT 1 FROM veo_telegram_memberships m JOIN veo_worker_mappings w USING(user_id) WHERE m.user_id=a.user_id AND m.chat_id=chat AND m.telegram_user_id=(person->>'telegram_user_id')::bigint AND m.telegram_user_id=w.telegram_user_id AND m.verified_at<=seen) THEN CONTINUE;END IF;
  SELECT payload INTO prior FROM veo_telegram_group_states WHERE user_id=a.user_id AND chat_id=chat;
  IF EXISTS(SELECT 1 FROM veo_telegram_group_states WHERE user_id=a.user_id AND chat_id=chat AND observed_at>=seen) THEN CONTINUE;END IF;
  SELECT jsonb_object_agg(key,value) INTO info FROM jsonb_each(jsonb_build_object('membership',person->'membership','membership_confirmed',person->'membership_confirmed','is_bot',person->'is_bot','attendance',person->'attendance','availability',person->'availability','page_access',person->'page_access','error',person->'error')) WHERE value<>'null'::jsonb;
  -- Preserve a previously verified declaration on incomplete reads; only an
  -- explicit newer withdrawal or a known replacement poll can clear it.
  IF prior->'attendance' IS NOT NULL AND((info->'attendance' IS NULL AND(info->'availability' IS NULL OR info->'availability'->>'poll_id' IS NOT DISTINCT FROM prior->'availability'->>'poll_id'))
   OR(info->'attendance'->>'updated_at')::timestamptz<=(prior->'attendance'->>'updated_at')::timestamptz) THEN info:=info||jsonb_build_object('attendance',prior->'attendance');END IF;
  INSERT INTO veo_telegram_group_states VALUES(a.user_id,chat,(person->>'telegram_user_id')::bigint,info,seen)
  ON CONFLICT(user_id,chat_id) DO UPDATE SET telegram_user_id=EXCLUDED.telegram_user_id,payload=EXCLUDED.payload,observed_at=EXCLUDED.observed_at;
  checked:=checked+1;
  SELECT count(*),count(*) FILTER(WHERE s.observed_at>=now()-interval '10 minutes' AND s.observed_at>=m.verified_at AND s.payload->>'membership' IN('left','kicked') AND s.payload->'membership_confirmed'='true'::jsonb AND s.payload->'is_bot'='false'::jsonb)
   INTO all_count,left_count FROM veo_telegram_memberships m LEFT JOIN veo_telegram_group_states s USING(user_id,chat_id)
   WHERE m.user_id=a.user_id AND veo_staff_can_telegram_group(a.user_id,m.chat_id);
  IF all_count>0 AND all_count=left_count THEN PERFORM veo_offboard(owner,a.user_id,'Jaucian confirmed departure from every current linked Telegram group','telegram_confirmed_departure');removed:=removed+1;CONTINUE;END IF;
  primary_chat:=veo_current_telegram_group(a.user_id);
  SELECT s.payload,s.observed_at INTO current_state,state_seen FROM veo_telegram_group_states s WHERE s.user_id=a.user_id AND veo_staff_can_telegram_group(a.user_id,s.chat_id)
   ORDER BY (s.payload->>'membership' IN('member','administrator','creator','restricted_member') AND s.payload->'membership_confirmed'='true'::jsonb AND s.payload->'is_bot'='false'::jsonb) DESC NULLS LAST,s.observed_at DESC LIMIT 1;
  SELECT s.payload->'attendance' INTO answer FROM veo_telegram_group_states s WHERE s.user_id=a.user_id AND veo_staff_can_telegram_group(a.user_id,s.chat_id)
   AND s.payload->>'membership' NOT IN('left','kicked') AND s.payload->'attendance'->>'work_date'=(veo_today()+1)::text AND jsonb_typeof(s.payload->'attendance'->'active')='boolean'
   AND(s.payload->'attendance'->>'updated_at')::timestamptz BETWEEN(SELECT launch_at FROM veo_tenants WHERE id=p_tenant) AND now()+interval '1 minute'
   ORDER BY(s.payload->'attendance'->>'updated_at')::timestamptz DESC,s.chat_id LIMIT 1;
  SELECT s.payload->'availability' INTO poll FROM veo_telegram_group_states s WHERE s.user_id=a.user_id AND veo_staff_can_telegram_group(a.user_id,s.chat_id)
   AND s.payload->'availability'->>'work_date'=(veo_today()+1)::text ORDER BY s.observed_at DESC LIMIT 1;
  IF answer IS NOT NULL AND poll IS NOT NULL THEN poll:=poll||jsonb_build_object('has_vote',true);END IF;
  INSERT INTO veo_telegram_staff_state(user_id,tenant_id,telegram_chat_id,telegram_user_id,membership,observed_at,attendance,availability,last_error)
  VALUES(a.user_id,p_tenant,primary_chat,(person->>'telegram_user_id')::bigint,coalesce(current_state->>'membership','unknown'),state_seen,answer,poll,current_state->>'error')
  ON CONFLICT(user_id) DO UPDATE SET telegram_chat_id=EXCLUDED.telegram_chat_id,telegram_user_id=EXCLUDED.telegram_user_id,membership=EXCLUDED.membership,observed_at=EXCLUDED.observed_at,attendance=EXCLUDED.attendance,availability=EXCLUDED.availability,last_error=EXCLUDED.last_error;
  IF a.role IN('member','manager') THEN
   SELECT to_jsonb(x) INTO prior FROM veo_attendance x WHERE x.user_id=a.user_id AND work_date=veo_today()+1;
   IF answer IS NOT NULL AND(prior IS NULL OR prior->>'source'<>'telegram' OR prior->'active' IS DISTINCT FROM answer->'active') THEN
    INSERT INTO veo_attendance(user_id,work_date,active,updated_by,updated_at,source) VALUES(a.user_id,veo_today()+1,(answer->>'active')::boolean,owner,seen,'telegram')
    ON CONFLICT(user_id,work_date) DO UPDATE SET active=EXCLUDED.active,updated_by=owner,updated_at=seen,source='telegram';
    INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value,reason) VALUES(p_tenant,owner,'telegram_attendance',a.user_id,prior,answer,'Latest current declaration across linked Telegram groups');imported:=imported+1;
   ELSIF answer IS NULL AND prior->>'source'='telegram' AND EXISTS(SELECT 1 FROM veo_telegram_group_states s WHERE s.user_id=a.user_id AND veo_staff_can_telegram_group(a.user_id,s.chat_id) AND s.payload->'attendance'->>'work_date'=(veo_today()+1)::text AND s.payload->'attendance'->'active'='null'::jsonb) THEN
    DELETE FROM veo_attendance WHERE user_id=a.user_id AND work_date=veo_today()+1;imported:=imported+1;
    INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value,reason) VALUES(p_tenant,owner,'telegram_attendance',a.user_id,prior,'null','Current linked-group votes withdrawn');
   END IF;
  END IF;
 END LOOP;
 UPDATE veo_telegram_sync_state SET last_sync_at=clock_timestamp(),cursor=greatest(0,coalesce((p_payload->>'next_offset')::int,0)),next_sync_at=now()+CASE WHEN coalesce((p_payload->>'next_offset')::int,0)>0 THEN interval '1 minute' ELSE interval '5 minutes' END,
  lease_until=NULL,last_error=NULL,counts=jsonb_build_object('checked',checked,'attendance_imported',imported,'departures',removed,'unmapped',coalesce((p_payload->>'unmapped')::int,0)) WHERE tenant_id=p_tenant;
 RETURN jsonb_build_object('checked',checked,'attendance_imported',imported,'departures',removed);
END $$;

ALTER FUNCTION veo_receipt_requirements(uuid,uuid,uuid,text,uuid,boolean) RENAME TO veo_receipt_requirements_before_groups;
CREATE FUNCTION veo_receipt_requirements(p_actor uuid,p_contact uuid,p_seller uuid,p_kind text,p_order uuid DEFAULT NULL,p_fresh boolean DEFAULT true) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE result jsonb;team uuid;pg uuid;BEGIN
 result:=veo_receipt_requirements_before_groups(p_actor,p_contact,p_seller,p_kind,p_order,p_fresh);
 SELECT c.page_id INTO pg FROM contacts c WHERE c.id=p_contact;
 SELECT t.id INTO team FROM veo_teams t JOIN veo_accounts a ON t.manager_id=CASE WHEN a.role='manager' THEN a.user_id ELSE a.parent_id END WHERE a.user_id=p_seller AND t.tenant_id=a.tenant_id;
 IF EXISTS(SELECT 1 FROM veo_teams WHERE id=team AND telegram_groups_managed) AND veo_telegram_destination(team,pg,p_seller)->>'chat_id' IS NULL THEN
  RETURN result||jsonb_build_object('allowed',false,'blockers',coalesce(result->'blockers','[]')||'"telegram_page_or_membership_required"'::jsonb);
 END IF;
 RETURN result;
END $$;
ALTER FUNCTION veo_receipt_facts(uuid) RENAME TO veo_receipt_facts_before_groups;
CREATE FUNCTION veo_receipt_facts(p_receipt uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;r veo_receipts;team uuid;dest jsonb;BEGIN
 result:=veo_receipt_facts_before_groups(p_receipt);SELECT * INTO r FROM veo_receipts WHERE id=p_receipt;
 SELECT coalesce((SELECT team_id FROM veo_closed_deals WHERE id=r.closed_deal_id),(SELECT team_id FROM veo_orders WHERE id=r.order_id)) INTO team;
 IF EXISTS(SELECT 1 FROM veo_teams WHERE id=team AND telegram_groups_managed) THEN
  dest:=veo_telegram_destination(team,r.page_id,r.seller_id);
  IF dest->>'chat_id' IS NULL AND NOT (coalesce(result->'holds','[]') ? 'telegram_page_or_membership_required') THEN RETURN result||jsonb_build_object('holds',coalesce(result->'holds','[]')||'"telegram_page_or_membership_required"'::jsonb);END IF;
 END IF;
 RETURN result;
END $$;
DO $warnings$ DECLARE definition text;anchor text:='EXISTS(SELECT 1 FROM veo_worker_mappings WHERE user_id=a.user_id) AS mapped';BEGIN
 definition:=pg_get_functiondef('veo_workflow_warnings(uuid,uuid)'::regprocedure);
 IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'Expected Telegram warning mapping guard';END IF;
 EXECUTE replace(definition,anchor,'(EXISTS(SELECT 1 FROM veo_worker_mappings WHERE user_id=a.user_id) AND veo_current_telegram_group(a.user_id) IS NOT NULL) AS mapped');
END $warnings$;
DO $$ DECLARE fn record;BEGIN
 FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_current_telegram_group','veo_apply_telegram_observations','veo_receipt_facts','veo_receipt_requirements','veo_action','veo_map_staff_telegram') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);
 END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
