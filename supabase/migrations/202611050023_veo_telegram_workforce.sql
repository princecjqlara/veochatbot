BEGIN;
ALTER TABLE veo_attendance ADD COLUMN source text NOT NULL DEFAULT 'workspace' CHECK(source IN('workspace','telegram'));
CREATE TABLE veo_staff_telegram_groups(user_id uuid PRIMARY KEY REFERENCES veo_accounts(user_id),telegram_chat_id bigint NOT NULL CHECK(telegram_chat_id<0),verified_at timestamptz NOT NULL DEFAULT now());
INSERT INTO veo_staff_telegram_groups(user_id,telegram_chat_id,verified_at)
SELECT m.user_id,t.telegram_chat_id,verified.created_at FROM veo_worker_mappings m JOIN veo_accounts a ON a.user_id=m.user_id
JOIN veo_teams t ON t.manager_id=CASE WHEN a.role='manager' THEN a.user_id ELSE a.parent_id END
JOIN LATERAL(SELECT max(created_at) AS created_at FROM veo_audit WHERE action='mapping' AND entity_id=m.user_id) verified ON verified.created_at IS NOT NULL
WHERE t.telegram_chat_id IS NOT NULL AND verified.created_at>=coalesce((SELECT max(created_at) FROM veo_audit WHERE action='mapping' AND entity_id=t.id),'-infinity'::timestamptz);
CREATE TABLE veo_telegram_staff_state(user_id uuid PRIMARY KEY REFERENCES veo_accounts(user_id),tenant_id uuid NOT NULL REFERENCES veo_tenants(id),telegram_chat_id bigint NOT NULL,telegram_user_id bigint NOT NULL,membership text NOT NULL,observed_at timestamptz NOT NULL,attendance jsonb,page_access jsonb,last_error text);
CREATE TABLE veo_telegram_sync_state(tenant_id uuid PRIMARY KEY REFERENCES veo_tenants(id),last_sync_at timestamptz,next_sync_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz,last_error text,counts jsonb NOT NULL DEFAULT '{}',cursor integer NOT NULL DEFAULT 0);
INSERT INTO veo_telegram_sync_state(tenant_id) SELECT id FROM veo_tenants WHERE launch_at IS NOT NULL;

CREATE FUNCTION veo_claim_telegram_sync() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE job veo_telegram_sync_state; BEGIN
 SELECT * INTO job FROM veo_telegram_sync_state WHERE next_sync_at<=now() AND(lease_until IS NULL OR lease_until<now()) ORDER BY next_sync_at LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE veo_telegram_sync_state SET lease_until=now()+interval '2 minutes' WHERE tenant_id=job.tenant_id;
 RETURN to_jsonb(job); END $$;

CREATE FUNCTION veo_apply_telegram_observations(p_tenant uuid,p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE person jsonb; account veo_accounts; owner uuid; chat bigint; observed timestamptz; answer jsonb; answer_at timestamptz; state text; imported integer:=0; removed integer:=0; checked integer:=0; old jsonb;
 BEGIN
 SELECT owner_id INTO owner FROM veo_tenants WHERE id=p_tenant AND launch_at IS NOT NULL;
 IF owner IS NULL OR jsonb_typeof(p_payload->'workers') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'workers')>5000 OR p_payload->>'tenant_id' IS DISTINCT FROM p_tenant::text THEN RAISE EXCEPTION 'Invalid connected workforce'; END IF;
 FOR person IN SELECT value FROM jsonb_array_elements(p_payload->'workers') LOOP
 SELECT * INTO account FROM veo_accounts WHERE user_id=(person->>'user_id')::uuid AND tenant_id=p_tenant AND active AND role<>'owner' FOR UPDATE;
 IF NOT FOUND THEN CONTINUE; END IF;
 IF NOT EXISTS(SELECT 1 FROM veo_worker_mappings WHERE user_id=account.user_id AND telegram_user_id=(person->>'telegram_user_id')::bigint) THEN CONTINUE; END IF;
 SELECT CASE WHEN account.role='team_leader' THEN(SELECT telegram_chat_id FROM veo_staff_telegram_groups WHERE user_id=account.user_id)
 ELSE(SELECT telegram_chat_id FROM veo_teams WHERE manager_id=CASE WHEN account.role='manager' THEN account.user_id ELSE account.parent_id END) END INTO chat;
 IF chat IS NULL OR chat<>(person->>'chat_id')::bigint THEN CONTINUE; END IF;
 observed:=(person->>'observed_at')::timestamptz;
 IF observed IS NULL OR observed<now()-interval '10 minutes' OR observed>now()+interval '1 minute' THEN CONTINUE; END IF;
 IF EXISTS(SELECT 1 FROM veo_telegram_staff_state WHERE user_id=account.user_id AND observed_at>=observed) THEN CONTINUE; END IF;
 state:=person->>'membership'; checked:=checked+1;
 INSERT INTO veo_telegram_staff_state(user_id,tenant_id,telegram_chat_id,telegram_user_id,membership,observed_at,attendance,page_access,last_error)
 VALUES(account.user_id,p_tenant,chat,(person->>'telegram_user_id')::bigint,coalesce(state,'unknown'),observed,person->'attendance',person->'page_access',person->>'error')
 ON CONFLICT(user_id) DO UPDATE SET telegram_chat_id=EXCLUDED.telegram_chat_id,telegram_user_id=EXCLUDED.telegram_user_id,membership=EXCLUDED.membership,observed_at=EXCLUDED.observed_at,attendance=EXCLUDED.attendance,page_access=EXCLUDED.page_access,last_error=EXCLUDED.last_error;
 IF state IN('left','kicked') AND person->'membership_confirmed'='true'::jsonb AND person->'is_bot'='false'::jsonb
 AND EXISTS(SELECT 1 FROM veo_staff_telegram_groups WHERE user_id=account.user_id AND telegram_chat_id=chat) THEN
 PERFORM veo_offboard(owner,account.user_id,'Jaucian confirmed departure from the explicitly mapped team group','telegram_confirmed_departure'); removed:=removed+1; CONTINUE;
 END IF;
 IF state IS NULL OR state NOT IN('member','administrator','creator','restricted_member') OR person->'is_bot' IS DISTINCT FROM 'false'::jsonb OR person->'membership_confirmed' IS DISTINCT FROM 'true'::jsonb THEN CONTINUE; END IF;
 INSERT INTO veo_staff_telegram_groups VALUES(account.user_id,chat,observed) ON CONFLICT(user_id) DO UPDATE SET telegram_chat_id=EXCLUDED.telegram_chat_id,verified_at=EXCLUDED.verified_at;
 answer:=person->'attendance';
 IF account.role IN('member','manager') AND answer->>'work_date'=(veo_today()+1)::text AND answer->>'updated_at' IS NOT NULL AND jsonb_typeof(answer->'active') IN('boolean','null') THEN
 answer_at:=(answer->>'updated_at')::timestamptz;
 IF answer_at>=(SELECT launch_at FROM veo_tenants WHERE id=p_tenant) AND answer_at<=now()+interval '1 minute' THEN
 SELECT to_jsonb(a) INTO old FROM veo_attendance a WHERE user_id=account.user_id AND work_date=veo_today()+1;
 IF old IS NULL OR (old->>'updated_at')::timestamptz<answer_at THEN
 IF answer->'active'='null'::jsonb THEN DELETE FROM veo_attendance WHERE user_id=account.user_id AND work_date=veo_today()+1;
 ELSIF jsonb_typeof(answer->'active')='boolean' THEN
 INSERT INTO veo_attendance(user_id,work_date,active,updated_by,updated_at,source) VALUES(account.user_id,veo_today()+1,(answer->>'active')::boolean,owner,answer_at,'telegram')
 ON CONFLICT(user_id,work_date) DO UPDATE SET active=EXCLUDED.active,updated_by=owner,updated_at=EXCLUDED.updated_at,source='telegram'; END IF;
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value,reason) VALUES(p_tenant,owner,'telegram_attendance',account.user_id,old,answer,'Verified mapped Telegram identity; latest declaration wins'); imported:=imported+1;
 END IF; END IF; END IF;
 END LOOP;
 UPDATE veo_telegram_sync_state SET last_sync_at=clock_timestamp(),cursor=greatest(0,coalesce((p_payload->>'next_offset')::int,0)),next_sync_at=now()+CASE WHEN coalesce((p_payload->>'next_offset')::int,0)>0 THEN interval '1 minute' ELSE interval '5 minutes' END,lease_until=NULL,last_error=NULL,counts=jsonb_build_object('checked',checked,'attendance_imported',imported,'departures',removed,'unmapped',coalesce((p_payload->>'unmapped')::int,0)) WHERE tenant_id=p_tenant;
 RETURN jsonb_build_object('checked',checked,'attendance_imported',imported,'departures',removed);
 END $$;

CREATE FUNCTION veo_map_staff_telegram(p_actor uuid,p_user uuid,p_telegram bigint,p_chat bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE staff veo_accounts; BEGIN
 IF NOT EXISTS(SELECT 1 FROM veo_accounts WHERE user_id=p_actor AND active AND role='owner') OR p_user NOT IN(SELECT veo_descendants(p_actor)) THEN RAISE EXCEPTION 'Owner access required' USING ERRCODE='42501'; END IF;
 SELECT * INTO staff FROM veo_accounts WHERE user_id=p_user AND active AND role<>'owner';
 IF NOT FOUND OR p_telegram<=0 OR NOT EXISTS(SELECT 1 FROM veo_teams t WHERE t.telegram_chat_id=p_chat AND(
 staff.role='team_leader' AND t.manager_id IN(SELECT veo_descendants(p_user)) OR t.manager_id=CASE WHEN staff.role='manager' THEN p_user ELSE staff.parent_id END)) THEN RAISE EXCEPTION 'Choose a mapped group in this employee''s branch'; END IF;
 INSERT INTO veo_worker_mappings VALUES(p_user,p_telegram) ON CONFLICT(user_id) DO UPDATE SET telegram_user_id=EXCLUDED.telegram_user_id;
 INSERT INTO veo_staff_telegram_groups VALUES(p_user,p_chat,now()) ON CONFLICT(user_id) DO UPDATE SET telegram_chat_id=EXCLUDED.telegram_chat_id,verified_at=clock_timestamp();
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value,reason) VALUES(staff.tenant_id,p_actor,'verified_telegram_mapping',p_user,jsonb_build_object('telegram_user_id',p_telegram,'chat_id',p_chat),'Current human group membership verified through Jaucian');
 RETURN jsonb_build_object('saved',true);
 END $$;

CREATE FUNCTION veo_operations_maintenance() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE cleared integer; tenant record; BEGIN
 FOR tenant IN SELECT owner_id FROM veo_tenants WHERE launch_at IS NOT NULL LOOP PERFORM veo_page_capacity(tenant.owner_id,veo_today()); END LOOP;
 WITH retired AS(SELECT event_key FROM veo_event_inbox WHERE status='done' AND received_at<now()-interval '7 days' AND payload<>'{}'::jsonb LIMIT 500)
 UPDATE veo_event_inbox i SET payload='{}'::jsonb FROM retired r WHERE i.event_key=r.event_key;
 GET DIAGNOSTICS cleared=ROW_COUNT;
 RETURN jsonb_build_object('completed_event_payloads_cleared',cleared,'financial_records_deleted',0,'archive_records_deleted',0);
 END $$;

ALTER FUNCTION veo_operations(uuid,date,date,uuid,uuid,text,text,integer) RENAME TO veo_operations_core;
CREATE FUNCTION veo_operations(p_actor uuid,p_from date,p_to date,p_page uuid DEFAULT NULL,p_worker uuid DEFAULT NULL,p_status text DEFAULT 'all',p_search text DEFAULT '',p_offset integer DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE result jsonb; employees jsonb;
 BEGIN
 result:=veo_operations_core(p_actor,p_from,p_to,p_page,p_worker,p_status,p_search,p_offset);
 SELECT coalesce(jsonb_agg(e.value||jsonb_build_object('active_today',(SELECT active FROM veo_attendance WHERE user_id=(e.value->>'id')::uuid AND work_date=veo_today()),
 'active_tomorrow',(SELECT active FROM veo_attendance WHERE user_id=(e.value->>'id')::uuid AND work_date=veo_today()+1),
 'telegram',(SELECT jsonb_build_object('membership',s.membership,'observed_at',s.observed_at,'error',s.last_error,'attendance',s.attendance,
 'reported_pages',coalesce((SELECT jsonb_agg(p.id) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.page_access->'page_ids')='array' THEN s.page_access->'page_ids' ELSE '[]'::jsonb END) r JOIN pages p ON p.id::text=(r.value#>>'{}') WHERE veo_can_page(p_actor,p.id)),'[]')) FROM veo_telegram_staff_state s WHERE s.user_id=(e.value->>'id')::uuid)) ORDER BY (e.value->>'rank')::int,e.value->>'name'),'[]') INTO employees FROM jsonb_array_elements(result->'employees') e;
 RETURN result||jsonb_build_object('employees',employees,'telegram_sync',(SELECT jsonb_build_object('last_sync_at',last_sync_at,'next_sync_at',next_sync_at,'last_error',last_error,'counts',counts) FROM veo_telegram_sync_state WHERE tenant_id=(result->'scope'->>'tenant_id')::uuid));
 END $$;

DO $migration$ DECLARE definition text; BEGIN
 definition:=pg_get_functiondef('veo_action(uuid,text,jsonb)'::regprocedure);
 definition:=replace(definition,'RETURN result;',$new$IF p_action='attendance' THEN UPDATE veo_attendance SET source='workspace' WHERE user_id=coalesce((p_data->>'user_id')::uuid,p_actor) AND work_date=(p_data->>'work_date')::date; END IF;
 RETURN result;$new$); EXECUTE definition;
END $migration$;
DO $$ DECLARE t text; fn record; BEGIN
 FOREACH t IN ARRAY ARRAY['veo_staff_telegram_groups','veo_telegram_staff_state','veo_telegram_sync_state'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,anon,authenticated',t);EXECUTE format('GRANT ALL ON %I TO service_role',t); END LOOP;
 FOR fn IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_claim_telegram_sync','veo_apply_telegram_observations','veo_map_staff_telegram','veo_operations_maintenance','veo_operations','veo_operations_core') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature); END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
