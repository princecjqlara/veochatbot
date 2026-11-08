BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL jit=off;

-- A team's existing manager_id is its supervising account. It may now be a
-- team leader, allowing direct members without inventing a manager account.
DO $$ DECLARE definition text; BEGIN
 definition:=pg_get_functiondef('veo_action_core(uuid,text,jsonb)'::regprocedure);
 IF position('(parent.role=''team_leader'' AND desired=''manager'')' IN definition)=0 THEN RAISE EXCEPTION 'Account hierarchy implementation changed';END IF;
 definition:=replace(definition,'(parent.role=''team_leader'' AND desired=''manager'')','(parent.role=''team_leader'' AND desired IN (''manager'',''member''))');
 definition:=replace(definition,'IF desired=''manager'' THEN INSERT INTO veo_teams','IF desired IN (''manager'',''team_leader'') THEN INSERT INTO veo_teams');
 definition:=replace(definition,'IF coalesce(cardinality(ids),0)=0 OR EXISTS','IF (coalesce(cardinality(ids),0)=0 AND desired<>''member'') OR EXISTS');
 EXECUTE definition;
END $$;
INSERT INTO veo_teams(tenant_id,manager_id,name)
 SELECT a.tenant_id,a.user_id,u.name||' (direct members)' FROM veo_accounts a JOIN users u ON u.id=a.user_id
 WHERE a.active AND a.role='team_leader' ON CONFLICT(manager_id) DO NOTHING;
-- Direct-member teams exclude their leader's child managers, who already have
-- their own teams. Keep capacity, reports and salary rosters disjoint.
DO $$ DECLARE fn record;definition text;BEGIN
 FOR fn IN SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'veo_%'
  AND prosrc LIKE '%a.parent_id=tm.manager_id%' LOOP
  definition:=pg_get_functiondef(fn.oid);
  definition:=replace(definition,'OR a.parent_id=tm.manager_id','OR (a.role=''member'' AND a.parent_id=tm.manager_id)');
  EXECUTE definition;
 END LOOP;
END $$;

ALTER TABLE veo_telegram_sync_state ADD COLUMN auto_cursor integer NOT NULL DEFAULT 0,
 ADD COLUMN auto_checked_at timestamptz,ADD COLUMN auto_last_error text;
CREATE TABLE veo_telegram_link_codes(
 user_id uuid PRIMARY KEY REFERENCES veo_accounts(user_id),code_hash text NOT NULL UNIQUE CHECK(length(code_hash)=64),
 expires_at timestamptz NOT NULL,consumed_by bigint,consumed_at timestamptz
);
CREATE TABLE veo_telegram_auto_grants(
 user_id uuid NOT NULL REFERENCES veo_accounts(user_id),page_id uuid NOT NULL REFERENCES pages(id),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,page_id)
);
CREATE TABLE veo_telegram_auto_states(
 user_id uuid NOT NULL REFERENCES veo_accounts(user_id),chat_id bigint NOT NULL,telegram_user_id bigint NOT NULL,
 membership text NOT NULL,observed_at timestamptz NOT NULL,PRIMARY KEY(user_id,chat_id)
);

CREATE FUNCTION veo_create_telegram_link(p_actor uuid,p_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a veo_accounts;BEGIN
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;
 IF a.user_id IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE='42501';END IF;
 IF p_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid link code';END IF;
 INSERT INTO veo_telegram_link_codes(user_id,code_hash,expires_at) VALUES(p_actor,p_hash,now()+interval '15 minutes')
 ON CONFLICT(user_id) DO UPDATE SET code_hash=EXCLUDED.code_hash,expires_at=EXCLUDED.expires_at,consumed_by=NULL,consumed_at=NULL;
 RETURN jsonb_build_object('expires_at',now()+interval '15 minutes');
END $$;

CREATE FUNCTION veo_confirm_telegram_link(p_tenant uuid,p_hash text,p_telegram bigint,p_chat bigint,p_username text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c veo_telegram_link_codes;a veo_accounts;owner uuid;BEGIN
 SELECT owner_id INTO owner FROM veo_tenants WHERE id=p_tenant AND launch_at IS NOT NULL;
 IF owner IS NULL OR p_telegram<=0 OR NOT EXISTS(SELECT 1 FROM veo_telegram_groups WHERE tenant_id=p_tenant AND chat_id=p_chat AND active) THEN RAISE EXCEPTION 'Choose an approved VEO group' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('veo-telegram-groups:'||p_tenant::text,0));
 SELECT * INTO c FROM veo_telegram_link_codes WHERE code_hash=p_hash AND expires_at>now() FOR UPDATE;
 SELECT * INTO a FROM veo_accounts WHERE user_id=c.user_id AND tenant_id=p_tenant AND active FOR UPDATE;
 IF a.user_id IS NULL OR c.consumed_at IS NOT NULL AND c.consumed_by IS DISTINCT FROM p_telegram THEN RAISE EXCEPTION 'Link code expired or already used' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM veo_worker_mappings WHERE user_id=a.user_id AND telegram_user_id<>p_telegram)
 OR EXISTS(SELECT 1 FROM veo_worker_mappings WHERE telegram_user_id=p_telegram AND user_id<>a.user_id) THEN RAISE EXCEPTION 'A different Telegram identity is already linked; ask your supervisor to review it' USING ERRCODE='23505';END IF;
 INSERT INTO veo_worker_mappings VALUES(a.user_id,p_telegram) ON CONFLICT(user_id) DO NOTHING;
 UPDATE veo_telegram_link_codes SET consumed_by=p_telegram,consumed_at=coalesce(consumed_at,clock_timestamp()) WHERE user_id=a.user_id;
 IF nullif(lower(p_username),'') ~ '^[a-z0-9_]{1,32}$' THEN
  UPDATE veo_accounts SET telegram_username=lower(p_username),telegram_profile_completed_at=clock_timestamp() WHERE user_id=a.user_id;
 END IF;
 UPDATE veo_telegram_sync_state SET next_sync_at=least(next_sync_at,now()),auto_cursor=0 WHERE tenant_id=p_tenant;
 IF c.consumed_at IS NULL THEN INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value) VALUES(p_tenant,owner,'telegram_self_link',a.user_id,jsonb_build_object('telegram_user_id',p_telegram,'chat_id',p_chat));END IF;
 RETURN jsonb_build_object('linked',true,'user_id',a.user_id);
END $$;

CREATE FUNCTION veo_apply_telegram_automation(p_tenant uuid,p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE owner uuid;person jsonb;a veo_accounts;g veo_telegram_groups;t veo_teams;pg uuid;ids uuid[];uid bigint;chat bigint;seen timestamptz;
 checked integer:=0;linked integer:=0;granted integer:=0;revoked integer:=0;valid boolean;state text;rec record;BEGIN
 SELECT owner_id INTO owner FROM veo_tenants WHERE id=p_tenant AND launch_at IS NOT NULL;
 IF owner IS NULL OR p_payload->>'tenant_id' IS DISTINCT FROM p_tenant::text OR jsonb_typeof(p_payload->'workers') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'workers')>200 THEN RAISE EXCEPTION 'Invalid automatic Telegram snapshot';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('veo-telegram-groups:'||p_tenant::text,0));
 -- Supervisors precede their members. A username declaration alone can never
 -- create an identity mapping or a permission grant.
 FOR person IN SELECT v.value FROM jsonb_array_elements(p_payload->'workers') v JOIN veo_accounts w ON w.user_id=(v.value->>'user_id')::uuid
  ORDER BY CASE w.role WHEN 'team_leader' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,w.user_id LOOP
  SELECT * INTO a FROM veo_accounts WHERE user_id=(person->>'user_id')::uuid AND tenant_id=p_tenant AND active AND role<>'owner' FOR UPDATE;
  IF NOT FOUND THEN CONTINUE;END IF;
  uid:=(person->>'telegram_user_id')::bigint;chat:=(person->>'chat_id')::bigint;seen:=(person->>'observed_at')::timestamptz;
  SELECT * INTO g FROM veo_telegram_groups WHERE tenant_id=p_tenant AND chat_id=chat AND active;
  IF g.chat_id IS NULL OR seen IS NULL OR seen NOT BETWEEN now()-interval '10 minutes' AND now()+interval '1 minute'
   OR person->'membership_confirmed' IS DISTINCT FROM 'true'::jsonb OR person->'is_bot' IS DISTINCT FROM 'false'::jsonb
   OR NOT EXISTS(SELECT 1 FROM veo_worker_mappings WHERE user_id=a.user_id AND telegram_user_id=uid) THEN CONTINUE;END IF;
  state:=person->>'membership';valid:=state IN('member','administrator','creator','restricted_member');
  IF NOT valid AND state NOT IN('left','kicked') THEN CONTINUE;END IF;
  INSERT INTO veo_telegram_auto_states VALUES(a.user_id,chat,uid,state,seen)
   ON CONFLICT(user_id,chat_id) DO UPDATE SET telegram_user_id=uid,membership=state,observed_at=seen WHERE veo_telegram_auto_states.observed_at<EXCLUDED.observed_at;
  IF NOT FOUND THEN CONTINUE;END IF;
  checked:=checked+1;
  -- Application roles are retained. Telegram administration discovers which
  -- groups an existing supervisor manages; it never promotes an account.
  IF valid AND a.role IN('team_leader','manager') AND state IN('administrator','creator') THEN
   SELECT * INTO t FROM veo_teams WHERE manager_id=a.user_id AND tenant_id=p_tenant;
   SELECT coalesce(array_agg(DISTINCT p.id),'{}') INTO ids FROM jsonb_array_elements(g.discovered_pages) d JOIN pages p ON p.id::text=d.value->>'id'
    WHERE veo_can_page(a.user_id,p.id) AND veo_can_page(owner,p.id)
    AND NOT EXISTS(SELECT 1 FROM veo_team_telegram_pages r WHERE r.team_id=t.id AND r.page_id=p.id AND r.chat_id<>chat);
   IF t.id IS NOT NULL AND cardinality(ids)>0 AND (NOT EXISTS(SELECT 1 FROM veo_team_telegram_groups WHERE team_id=t.id AND chat_id=chat)
    OR EXISTS(SELECT 1 FROM unnest(ids) p WHERE NOT EXISTS(SELECT 1 FROM veo_team_telegram_pages WHERE team_id=t.id AND page_id=p AND chat_id=chat))) THEN
    -- Keep explicit Page routes, adding registered Pages without moving any
    -- existing destination or removing a supervisor's deliberate additions.
    SELECT array_agg(DISTINCT p) INTO ids FROM(SELECT unnest(ids) p UNION SELECT page_id FROM veo_team_telegram_pages WHERE team_id=t.id AND chat_id=chat) x;
    PERFORM veo_telegram_group_action(owner,'group',jsonb_build_object('team_id',t.id,'chat_id',chat,'page_ids',ids));linked:=linked+1;
   END IF;
  END IF;
  IF valid AND EXISTS(SELECT 1 FROM veo_team_telegram_groups l JOIN veo_teams tm ON tm.id=l.team_id JOIN veo_team_telegram_pages r ON r.team_id=tm.id AND r.chat_id=chat
   WHERE l.tenant_id=p_tenant AND l.chat_id=chat AND veo_can_page(tm.manager_id,r.page_id) AND veo_can_page(veo_grant_parent(a.user_id),r.page_id)
   AND(a.role='team_leader' AND tm.manager_id IN(SELECT veo_descendants(a.user_id)) OR tm.manager_id=CASE WHEN a.role='manager' THEN a.user_id ELSE a.parent_id END)) THEN
   INSERT INTO veo_telegram_memberships VALUES(a.user_id,p_tenant,chat,uid,seen,owner)
    ON CONFLICT(user_id,chat_id) DO UPDATE SET telegram_user_id=uid,verified_at=seen;
   INSERT INTO veo_staff_telegram_groups VALUES(a.user_id,chat,seen) ON CONFLICT(user_id) DO NOTHING;
  END IF;
 END LOOP;
 -- Reconcile every known identity, including members processed before their
 -- supervisor's batch. Existing manual grants are never adopted or removed.
 FOR a IN SELECT w.* FROM veo_accounts w JOIN users u ON u.id=w.user_id AND u.is_active WHERE w.tenant_id=p_tenant AND w.active AND w.role<>'owner'
  ORDER BY CASE w.role WHEN 'team_leader' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END LOOP
  FOR rec IN SELECT s.* FROM veo_telegram_auto_states s JOIN veo_worker_mappings m USING(user_id,telegram_user_id)
   JOIN veo_telegram_groups tg ON tg.tenant_id=p_tenant AND tg.chat_id=s.chat_id AND tg.active
   WHERE s.user_id=a.user_id AND s.membership IN('member','administrator','creator','restricted_member') AND s.observed_at>now()-interval '10 minutes' LOOP
   IF EXISTS(SELECT 1 FROM veo_team_telegram_groups l JOIN veo_teams tm ON tm.id=l.team_id JOIN veo_team_telegram_pages r ON r.team_id=tm.id AND r.chat_id=l.chat_id
    WHERE l.tenant_id=p_tenant AND l.chat_id=rec.chat_id AND veo_can_page(tm.manager_id,r.page_id) AND veo_can_page(veo_grant_parent(a.user_id),r.page_id)
    AND(a.role='team_leader' AND tm.manager_id IN(SELECT veo_descendants(a.user_id)) OR tm.manager_id=CASE WHEN a.role='manager' THEN a.user_id ELSE a.parent_id END)) THEN
    INSERT INTO veo_telegram_memberships VALUES(a.user_id,p_tenant,rec.chat_id,rec.telegram_user_id,rec.observed_at,owner) ON CONFLICT(user_id,chat_id) DO UPDATE SET verified_at=EXCLUDED.verified_at;
   END IF;
  END LOOP;
  FOR pg IN SELECT DISTINCT r.page_id FROM veo_telegram_memberships m JOIN veo_telegram_auto_states s USING(user_id,chat_id,telegram_user_id)
   JOIN veo_worker_mappings wm USING(user_id,telegram_user_id) JOIN veo_telegram_groups tg ON tg.tenant_id=p_tenant AND tg.chat_id=m.chat_id AND tg.active
   JOIN veo_team_telegram_groups l ON l.tenant_id=p_tenant AND l.chat_id=m.chat_id JOIN veo_teams tm ON tm.id=l.team_id JOIN veo_team_telegram_pages r ON r.team_id=tm.id AND r.chat_id=l.chat_id
   WHERE m.user_id=a.user_id AND s.membership IN('member','administrator','creator','restricted_member') AND s.observed_at>now()-interval '10 minutes'
   AND veo_can_page(tm.manager_id,r.page_id) AND veo_can_page(veo_grant_parent(a.user_id),r.page_id)
   AND(a.role='team_leader' AND tm.manager_id IN(SELECT veo_descendants(a.user_id)) OR tm.manager_id=CASE WHEN a.role='manager' THEN a.user_id ELSE a.parent_id END) LOOP
   INSERT INTO user_pages(user_id,page_id) VALUES(a.user_id,pg) ON CONFLICT(user_id,page_id) DO NOTHING;
   IF FOUND THEN
    INSERT INTO veo_telegram_auto_grants(user_id,page_id) VALUES(a.user_id,pg) ON CONFLICT DO NOTHING;granted:=granted+1;
    INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value) VALUES(p_tenant,owner,'telegram_auto_page_grant',a.user_id,jsonb_build_object('page_id',pg));
   END IF;
  END LOOP;
  FOR pg IN SELECT ag.page_id FROM veo_telegram_auto_grants ag WHERE ag.user_id=a.user_id AND(
   NOT veo_can_page(veo_grant_parent(a.user_id),ag.page_id) OR NOT EXISTS(
    SELECT 1 FROM veo_telegram_memberships m JOIN veo_telegram_auto_states s USING(user_id,chat_id,telegram_user_id) JOIN veo_worker_mappings wm USING(user_id,telegram_user_id)
    JOIN veo_telegram_groups tg ON tg.tenant_id=p_tenant AND tg.chat_id=m.chat_id AND tg.active
    JOIN veo_team_telegram_groups l ON l.tenant_id=p_tenant AND l.chat_id=m.chat_id JOIN veo_teams tm ON tm.id=l.team_id JOIN veo_team_telegram_pages r ON r.team_id=tm.id AND r.chat_id=l.chat_id
    WHERE m.user_id=a.user_id AND r.page_id=ag.page_id AND veo_can_page(tm.manager_id,r.page_id)
    AND(a.role='team_leader' AND tm.manager_id IN(SELECT veo_descendants(a.user_id)) OR tm.manager_id=CASE WHEN a.role='manager' THEN a.user_id ELSE a.parent_id END)
    -- Unknown / stale observations retain existing access; only a confirmed
    -- departure, a removed route, or revoked supervisor access removes it.
    AND NOT(s.membership IN('left','kicked') AND s.observed_at>now()-interval '10 minutes')
   )) LOOP
   DELETE FROM user_pages WHERE user_id=a.user_id AND page_id=pg;DELETE FROM veo_telegram_auto_grants WHERE user_id=a.user_id AND page_id=pg;revoked:=revoked+1;
   INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value) VALUES(p_tenant,owner,'telegram_auto_page_revoke',a.user_id,jsonb_build_object('page_id',pg));
  END LOOP;
 END LOOP;
 UPDATE veo_telegram_sync_state SET auto_cursor=greatest(0,coalesce((p_payload->>'next_offset')::int,0)),auto_checked_at=clock_timestamp(),auto_last_error=NULL WHERE tenant_id=p_tenant;
 RETURN jsonb_build_object('checked',checked,'linked_groups',linked,'granted_pages',granted,'revoked_pages',revoked);
END $$;

-- An explicit supervisor Page edit becomes the authority for its selected
-- grants, rather than letting later automation remove those manual grants.
ALTER FUNCTION veo_action(uuid,text,jsonb) RENAME TO veo_action_before_automatic_groups;
CREATE FUNCTION veo_action(p_actor uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;BEGIN
 result:=veo_action_before_automatic_groups(p_actor,p_action,p_data);
 IF p_action='assign_pages' THEN DELETE FROM veo_telegram_auto_grants WHERE user_id=(p_data->>'user_id')::uuid;END IF;
 RETURN result;
END $$;
ALTER FUNCTION veo_telegram_groups_page(uuid) RENAME TO veo_telegram_groups_page_before_automatic;
CREATE FUNCTION veo_telegram_groups_page(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE result jsonb;BEGIN
 result:=veo_telegram_groups_page_before_automatic(p_actor);
 RETURN result||jsonb_build_object('automation',(SELECT jsonb_build_object('checked_at',s.auto_checked_at,'error',s.auto_last_error,'pending',s.auto_cursor>0)
  FROM veo_telegram_sync_state s WHERE s.tenant_id=(result->'scope'->>'tenant_id')::uuid));
END $$;
DO $$ DECLARE tab text;fn record;BEGIN
 FOREACH tab IN ARRAY ARRAY['veo_telegram_link_codes','veo_telegram_auto_grants','veo_telegram_auto_states'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,anon,authenticated',tab);EXECUTE format('GRANT ALL ON %I TO service_role',tab);
 END LOOP;
 FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_create_telegram_link','veo_confirm_telegram_link','veo_apply_telegram_automation','veo_action','veo_telegram_groups_page') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);
 END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
