BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL jit=off;
ALTER TABLE veo_teams ADD COLUMN telegram_groups_managed boolean NOT NULL DEFAULT false;
CREATE TABLE veo_telegram_groups(
 tenant_id uuid NOT NULL REFERENCES veo_tenants(id),chat_id bigint NOT NULL CHECK(chat_id<0),name text NOT NULL,
 topics jsonb NOT NULL DEFAULT '{}',discovered_pages jsonb NOT NULL DEFAULT '[]',identities jsonb NOT NULL DEFAULT '[]',
 active boolean NOT NULL DEFAULT true,checked_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,chat_id)
);
CREATE TABLE veo_team_telegram_groups(
 team_id uuid NOT NULL REFERENCES veo_teams(id),tenant_id uuid NOT NULL REFERENCES veo_tenants(id),chat_id bigint NOT NULL,
 thread_id bigint CHECK(thread_id>0),updated_by uuid NOT NULL REFERENCES veo_accounts(user_id),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(team_id,chat_id),FOREIGN KEY(tenant_id,chat_id) REFERENCES veo_telegram_groups(tenant_id,chat_id)
);
CREATE TABLE veo_team_telegram_pages(
 team_id uuid NOT NULL,page_id uuid NOT NULL REFERENCES pages(id),chat_id bigint NOT NULL,
 PRIMARY KEY(team_id,page_id),FOREIGN KEY(team_id,chat_id) REFERENCES veo_team_telegram_groups(team_id,chat_id) ON DELETE CASCADE
);
CREATE TABLE veo_telegram_memberships(
 user_id uuid NOT NULL REFERENCES veo_accounts(user_id),tenant_id uuid NOT NULL REFERENCES veo_tenants(id),chat_id bigint NOT NULL,
 telegram_user_id bigint NOT NULL CHECK(telegram_user_id>0),verified_at timestamptz NOT NULL DEFAULT now(),verified_by uuid NOT NULL REFERENCES veo_accounts(user_id),
 PRIMARY KEY(user_id,chat_id),FOREIGN KEY(tenant_id,chat_id) REFERENCES veo_telegram_groups(tenant_id,chat_id)
);
CREATE TABLE veo_telegram_group_states(
 user_id uuid NOT NULL,chat_id bigint NOT NULL,telegram_user_id bigint NOT NULL,payload jsonb NOT NULL,observed_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,chat_id),FOREIGN KEY(user_id,chat_id) REFERENCES veo_telegram_memberships(user_id,chat_id) ON DELETE CASCADE
);
CREATE INDEX veo_telegram_membership_identity ON veo_telegram_memberships(tenant_id,telegram_user_id,chat_id);

CREATE FUNCTION veo_staff_can_telegram_group(p_user uuid,p_chat bigint) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM veo_accounts a JOIN users u ON u.id=a.user_id AND u.is_active JOIN veo_telegram_groups g ON g.tenant_id=a.tenant_id AND g.chat_id=p_chat AND g.active
 WHERE a.user_id=p_user AND a.active AND EXISTS(
 SELECT 1 FROM veo_team_telegram_groups l JOIN veo_teams t ON t.id=l.team_id JOIN veo_team_telegram_pages r ON r.team_id=l.team_id AND r.chat_id=l.chat_id
 WHERE l.tenant_id=a.tenant_id AND l.chat_id=p_chat AND veo_can_page(p_user,r.page_id) AND veo_can_page(t.manager_id,r.page_id)
 AND(a.role='owner' OR(a.role='team_leader' AND t.manager_id IN(SELECT veo_descendants(p_user))) OR t.manager_id=CASE WHEN a.role='manager' THEN a.user_id ELSE a.parent_id END)))
$$;

CREATE FUNCTION veo_sync_telegram_groups(p_actor uuid,p_groups jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a veo_accounts;g jsonb;BEGIN
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active AND role='owner';
 IF a.user_id IS NULL THEN RAISE EXCEPTION 'Head access required to fetch the bot directory' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(p_groups) IS DISTINCT FROM 'array' OR jsonb_array_length(p_groups)>200 THEN RAISE EXCEPTION 'Invalid bot directory';END IF;
 UPDATE veo_telegram_groups SET active=false WHERE tenant_id=a.tenant_id;
 FOR g IN SELECT value FROM jsonb_array_elements(p_groups) LOOP
  IF (g->>'chat_id')::bigint>=0 OR length(g->>'name')>200 OR jsonb_typeof(g->'pages') IS DISTINCT FROM 'array' OR jsonb_typeof(g->'identities') IS DISTINCT FROM 'array' OR length(g::text)>1000000 THEN RAISE EXCEPTION 'Invalid group metadata';END IF;
  INSERT INTO veo_telegram_groups(tenant_id,chat_id,name,topics,discovered_pages,identities,active,checked_at)
  VALUES(a.tenant_id,(g->>'chat_id')::bigint,g->>'name',coalesce(g->'topics','{}'),g->'pages',g->'identities',true,clock_timestamp())
  ON CONFLICT(tenant_id,chat_id) DO UPDATE SET name=EXCLUDED.name,topics=EXCLUDED.topics,discovered_pages=EXCLUDED.discovered_pages,identities=EXCLUDED.identities,active=true,checked_at=EXCLUDED.checked_at;
 END LOOP;
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value) VALUES(a.tenant_id,p_actor,'telegram_directory_refresh',a.tenant_id,jsonb_build_object('groups',jsonb_array_length(p_groups)));
 RETURN jsonb_build_object('saved',true,'groups',jsonb_array_length(p_groups));
END $$;

CREATE FUNCTION veo_telegram_groups_page(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit=off SET plan_cache_mode=force_custom_plan AS $$
DECLARE a veo_accounts;branch uuid[];ids uuid[];BEGIN
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;
 IF a.user_id IS NULL THEN RAISE EXCEPTION 'Workspace access denied' USING ERRCODE='42501';END IF;
 SELECT coalesce(array_agg(id),'{}') INTO branch FROM veo_descendants(p_actor) id;
 SELECT coalesce(array_agg(id),'{}') INTO ids FROM pages WHERE veo_can_page(p_actor,id);
 RETURN jsonb_build_object('scope',veo_scope(p_actor),'can_manage',a.role IN('owner','team_leader','manager'),
 'pages',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name) FROM pages WHERE id=ANY(ids)),'[]'),
 'teams',coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.name) FROM veo_teams t WHERE t.tenant_id=a.tenant_id AND t.manager_id=ANY(branch)),'[]'),
 'accounts',coalesce((SELECT jsonb_agg(jsonb_build_object('user_id',w.user_id,'name',u.name,'role',w.role,'parent_id',w.parent_id,'telegram_username',w.telegram_username,'telegram_user_id',m.telegram_user_id,
 'page_ids',ARRAY(SELECT p.id FROM pages p WHERE p.id=ANY(ids) AND veo_can_page(w.user_id,p.id))) ORDER BY u.name) FROM veo_accounts w JOIN users u ON u.id=w.user_id LEFT JOIN veo_worker_mappings m ON m.user_id=w.user_id WHERE w.active AND w.user_id=ANY(branch)),'[]'),
 'groups',coalesce((SELECT jsonb_agg(jsonb_build_object('chat_id',g.chat_id,'name',g.name,'topics',g.topics,'active',g.active,'checked_at',g.checked_at,
 'pages',CASE WHEN a.role='owner' THEN g.discovered_pages ELSE coalesce((SELECT jsonb_agg(p.value) FROM jsonb_array_elements(g.discovered_pages) p WHERE p.value->>'id'=ANY(ARRAY(SELECT id::text FROM unnest(ids) id))),'[]') END,
 'identities',CASE WHEN a.role='owner' OR EXISTS(SELECT 1 FROM veo_team_telegram_groups l JOIN veo_teams t ON t.id=l.team_id WHERE l.chat_id=g.chat_id AND t.manager_id=ANY(branch)) THEN g.identities ELSE '[]'::jsonb END)
 ORDER BY g.name) FROM veo_telegram_groups g WHERE g.tenant_id=a.tenant_id AND(a.role='owner' OR EXISTS(SELECT 1 FROM veo_team_telegram_groups l JOIN veo_teams t ON t.id=l.team_id WHERE l.chat_id=g.chat_id AND t.manager_id=ANY(branch))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(g.discovered_pages) p WHERE p.value->>'id'=ANY(ARRAY(SELECT id::text FROM unnest(ids) id))) OR EXISTS(SELECT 1 FROM veo_telegram_memberships m WHERE m.user_id=p_actor AND m.chat_id=g.chat_id))),'[]'),
 'links',coalesce((SELECT jsonb_agg(to_jsonb(l)) FROM veo_team_telegram_groups l JOIN veo_teams t ON t.id=l.team_id WHERE l.tenant_id=a.tenant_id AND t.manager_id=ANY(branch)),'[]'),
 'routes',coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM veo_team_telegram_pages r JOIN veo_teams t ON t.id=r.team_id WHERE t.tenant_id=a.tenant_id AND t.manager_id=ANY(branch) AND r.page_id=ANY(ids)),'[]'),
 'memberships',coalesce((SELECT jsonb_agg(to_jsonb(m)||jsonb_build_object('state',s.payload->>'membership','checked_at',s.observed_at)) FROM veo_telegram_memberships m LEFT JOIN veo_telegram_group_states s USING(user_id,chat_id) WHERE m.tenant_id=a.tenant_id AND m.user_id=ANY(branch)),'[]'),
 'coverage','Approved VEO groups registered with Jaucian. Page metadata is not a permission grant. Observed identities are not a complete membership list.');
END $$;

CREATE FUNCTION veo_telegram_group_action(p_actor uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a veo_accounts;t veo_teams;w veo_accounts;chat bigint;uid bigint;pg uuid;ids uuid[];old jsonb;BEGIN
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active AND role IN('owner','team_leader','manager');
 IF a.user_id IS NULL THEN RAISE EXCEPTION 'Supervisor access required' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('veo-telegram-groups:'||a.tenant_id::text,0));
 chat:=(p_data->>'chat_id')::bigint;
 IF NOT EXISTS(SELECT 1 FROM veo_telegram_groups WHERE tenant_id=a.tenant_id AND chat_id=chat AND active) AND p_action NOT IN('remove_group','remove_membership') THEN RAISE EXCEPTION 'Fetch the approved active bot groups first';END IF;
 IF p_action IN('group','remove_group') THEN
  SELECT * INTO t FROM veo_teams WHERE id=(p_data->>'team_id')::uuid AND tenant_id=a.tenant_id FOR UPDATE;
  IF t.id IS NULL OR t.manager_id NOT IN(SELECT veo_descendants(p_actor)) THEN RAISE EXCEPTION 'Team is outside your branch' USING ERRCODE='42501';END IF;
  old:=to_jsonb(t);
  IF NOT t.telegram_groups_managed AND t.telegram_chat_id IS NOT NULL AND EXISTS(SELECT 1 FROM veo_telegram_groups WHERE tenant_id=a.tenant_id AND chat_id=t.telegram_chat_id AND active) THEN
   INSERT INTO veo_team_telegram_groups VALUES(t.id,a.tenant_id,t.telegram_chat_id,t.telegram_thread_id,p_actor,now()) ON CONFLICT DO NOTHING;
   INSERT INTO veo_team_telegram_pages SELECT t.id,p.id,t.telegram_chat_id FROM pages p WHERE veo_can_page(t.manager_id,p.id) ON CONFLICT DO NOTHING;
   INSERT INTO veo_telegram_memberships(user_id,tenant_id,chat_id,telegram_user_id,verified_at,verified_by)
   SELECT s.user_id,a.tenant_id,s.telegram_chat_id,m.telegram_user_id,s.verified_at,p_actor FROM veo_staff_telegram_groups s JOIN veo_worker_mappings m USING(user_id)
   WHERE s.telegram_chat_id=t.telegram_chat_id AND veo_staff_can_telegram_group(s.user_id,t.telegram_chat_id) ON CONFLICT DO NOTHING;
  END IF;
  IF p_action='group' THEN
   IF jsonb_typeof(p_data->'page_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'page_ids') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Choose at least one Page';END IF;
   SELECT array_agg(DISTINCT value::uuid) INTO ids FROM jsonb_array_elements_text(p_data->'page_ids');
   FOREACH pg IN ARRAY ids LOOP
    IF NOT veo_can_page(p_actor,pg) OR NOT veo_can_page(t.manager_id,pg) THEN RAISE EXCEPTION 'Grant only Pages permitted for both you and the team manager' USING ERRCODE='42501';END IF;
    IF a.role<>'owner' AND NOT EXISTS(SELECT 1 FROM veo_team_telegram_groups l JOIN veo_teams x ON x.id=l.team_id WHERE l.chat_id=chat AND x.manager_id IN(SELECT veo_descendants(p_actor)))
     AND NOT EXISTS(SELECT 1 FROM veo_telegram_groups g CROSS JOIN LATERAL jsonb_array_elements(g.discovered_pages) p WHERE g.tenant_id=a.tenant_id AND g.chat_id=chat AND p.value->>'id'=pg::text)
    THEN RAISE EXCEPTION 'Head must link this group before adding Pages beyond its registered scope' USING ERRCODE='42501';END IF;
    IF EXISTS(SELECT 1 FROM veo_team_telegram_pages WHERE team_id=t.id AND page_id=pg AND chat_id<>chat) AND coalesce((p_data->>'move_pages')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'A selected Page is linked to another group. Explicitly choose Move Pages to change its destination' USING ERRCODE='23505';END IF;
   END LOOP;
   INSERT INTO veo_team_telegram_groups VALUES(t.id,a.tenant_id,chat,nullif(p_data->>'thread_id','')::bigint,p_actor,clock_timestamp())
   ON CONFLICT(team_id,chat_id) DO UPDATE SET thread_id=EXCLUDED.thread_id,updated_by=p_actor,updated_at=clock_timestamp();
   DELETE FROM veo_team_telegram_pages r WHERE r.team_id=t.id AND r.chat_id=chat AND NOT(r.page_id=ANY(ids)) AND veo_can_page(p_actor,r.page_id);
   INSERT INTO veo_team_telegram_pages SELECT t.id,p,chat FROM unnest(ids) p ON CONFLICT(team_id,page_id) DO UPDATE SET chat_id=EXCLUDED.chat_id;
   UPDATE veo_teams SET telegram_groups_managed=true,telegram_chat_id=CASE WHEN telegram_chat_id IS NULL OR coalesce((p_data->>'primary')::boolean,false) THEN chat ELSE telegram_chat_id END,
    telegram_thread_id=CASE WHEN telegram_chat_id IS NULL OR coalesce((p_data->>'primary')::boolean,false) OR telegram_chat_id=chat THEN nullif(p_data->>'thread_id','')::bigint ELSE telegram_thread_id END WHERE id=t.id;
  ELSE
   IF EXISTS(SELECT 1 FROM veo_team_telegram_pages WHERE team_id=t.id AND chat_id=chat AND NOT veo_can_page(p_actor,page_id)) THEN RAISE EXCEPTION 'Head must remove group links containing Pages outside your scope' USING ERRCODE='42501';END IF;
   DELETE FROM veo_team_telegram_groups WHERE team_id=t.id AND chat_id=chat;
   UPDATE veo_teams SET telegram_groups_managed=true,telegram_chat_id=(SELECT chat_id FROM veo_team_telegram_groups WHERE team_id=t.id ORDER BY updated_at LIMIT 1),
    telegram_thread_id=(SELECT thread_id FROM veo_team_telegram_groups WHERE team_id=t.id ORDER BY updated_at LIMIT 1) WHERE id=t.id AND(telegram_chat_id=chat OR telegram_chat_id IS NULL);
  END IF;
  INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value) VALUES(a.tenant_id,p_actor,'telegram_'||p_action,t.id,old,p_data);
 ELSIF p_action IN('membership','remove_membership') THEN
  SELECT * INTO w FROM veo_accounts WHERE user_id=(p_data->>'user_id')::uuid AND tenant_id=a.tenant_id AND active FOR UPDATE;
  IF w.user_id IS NULL OR w.user_id NOT IN(SELECT veo_descendants(p_actor)) THEN RAISE EXCEPTION 'Staff account is outside your branch' USING ERRCODE='42501';END IF;
  IF p_action='membership' THEN
   uid:=(p_data->>'telegram_user_id')::bigint;
   IF uid IS NULL OR uid<=0 OR NOT veo_staff_can_telegram_group(w.user_id,chat) THEN RAISE EXCEPTION 'Choose a linked group with permitted Pages for this person';END IF;
   IF EXISTS(SELECT 1 FROM veo_telegram_memberships WHERE user_id=w.user_id AND telegram_user_id<>uid) THEN RAISE EXCEPTION 'Use the same verified Telegram identity across groups; remove old memberships before changing identity';END IF;
   IF EXISTS(SELECT 1 FROM veo_worker_mappings m JOIN veo_accounts x USING(user_id) WHERE x.tenant_id=a.tenant_id AND x.active AND m.telegram_user_id=uid AND m.user_id<>w.user_id) THEN RAISE EXCEPTION 'That Telegram identity already belongs to another active account' USING ERRCODE='23505';END IF;
   INSERT INTO veo_worker_mappings VALUES(w.user_id,uid) ON CONFLICT(user_id) DO UPDATE SET telegram_user_id=EXCLUDED.telegram_user_id;
   INSERT INTO veo_telegram_memberships VALUES(w.user_id,a.tenant_id,chat,uid,clock_timestamp(),p_actor) ON CONFLICT(user_id,chat_id) DO UPDATE SET telegram_user_id=uid,verified_at=clock_timestamp(),verified_by=p_actor;
   DELETE FROM veo_telegram_group_states WHERE user_id=w.user_id AND chat_id=chat;
   IF coalesce((p_data->>'primary')::boolean,false) OR NOT EXISTS(SELECT 1 FROM veo_staff_telegram_groups WHERE user_id=w.user_id) THEN
    INSERT INTO veo_staff_telegram_groups VALUES(w.user_id,chat,clock_timestamp()) ON CONFLICT(user_id) DO UPDATE SET telegram_chat_id=chat,verified_at=clock_timestamp();
   END IF;
  ELSE
   DELETE FROM veo_telegram_memberships WHERE user_id=w.user_id AND chat_id=chat;
   DELETE FROM veo_staff_telegram_groups WHERE user_id=w.user_id AND telegram_chat_id=chat;
   INSERT INTO veo_staff_telegram_groups SELECT w.user_id,m.chat_id,m.verified_at FROM veo_telegram_memberships m WHERE m.user_id=w.user_id AND veo_staff_can_telegram_group(w.user_id,m.chat_id) ORDER BY m.verified_at LIMIT 1 ON CONFLICT DO NOTHING;
  END IF;
  INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value) VALUES(a.tenant_id,p_actor,'telegram_'||p_action,w.user_id,p_data);
 ELSE RAISE EXCEPTION 'Unknown group action';END IF;
 RETURN jsonb_build_object('saved',true);
END $$;

CREATE FUNCTION veo_telegram_destination(p_team uuid,p_page uuid,p_user uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t veo_teams;r record;BEGIN
 SELECT * INTO t FROM veo_teams WHERE id=p_team;
 IF NOT t.telegram_groups_managed THEN RETURN jsonb_build_object('chat_id',t.telegram_chat_id,'thread_id',t.telegram_thread_id);END IF;
 SELECT l.chat_id,l.thread_id INTO r FROM veo_team_telegram_pages p JOIN veo_team_telegram_groups l USING(team_id,chat_id) JOIN veo_telegram_groups g ON g.tenant_id=l.tenant_id AND g.chat_id=l.chat_id AND g.active
 WHERE p.team_id=p_team AND p.page_id=p_page AND veo_can_page(t.manager_id,p_page) AND veo_can_page(p_user,p_page)
 AND EXISTS(SELECT 1 FROM veo_telegram_memberships m JOIN veo_worker_mappings w USING(user_id) WHERE m.user_id=p_user AND m.chat_id=l.chat_id AND m.telegram_user_id=w.telegram_user_id);
 RETURN CASE WHEN FOUND THEN jsonb_build_object('chat_id',r.chat_id,'thread_id',r.thread_id) ELSE NULL END;
END $$;
ALTER FUNCTION veo_handoff(uuid) RENAME TO veo_handoff_before_groups;
CREATE FUNCTION veo_handoff(p_submission uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;dest jsonb;BEGIN
 result:=veo_handoff_before_groups(p_submission);IF result IS NULL THEN RETURN NULL;END IF;
 dest:=veo_telegram_destination((result->>'team_id')::uuid,(result->>'page_id')::uuid,(result->>'seller_id')::uuid);
 IF dest->>'chat_id' IS NULL THEN RETURN NULL;END IF;
 RETURN result||jsonb_build_object('telegram_chat_id',(dest->>'chat_id')::bigint,'telegram_thread_id',dest->'thread_id');
END $$;
DO $$ DECLARE tab text;fn record;BEGIN
 FOREACH tab IN ARRAY ARRAY['veo_telegram_groups','veo_team_telegram_groups','veo_team_telegram_pages','veo_telegram_memberships','veo_telegram_group_states'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,anon,authenticated',tab);EXECUTE format('GRANT ALL ON %I TO service_role',tab);
 END LOOP;
 FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_staff_can_telegram_group','veo_sync_telegram_groups','veo_telegram_groups_page','veo_telegram_group_action','veo_telegram_destination','veo_handoff') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);
 END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
