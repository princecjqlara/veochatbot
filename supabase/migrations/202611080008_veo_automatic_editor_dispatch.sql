BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL jit=off;
ALTER TABLE veo_telegram_groups ADD COLUMN intake_enabled boolean NOT NULL DEFAULT false;
ALTER FUNCTION veo_sync_telegram_groups(uuid,jsonb) RENAME TO veo_sync_telegram_groups_before_intake_policy;
CREATE FUNCTION veo_sync_telegram_groups(p_actor uuid,p_groups jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;BEGIN
 result:=veo_sync_telegram_groups_before_intake_policy(p_actor,p_groups);
 UPDATE veo_telegram_groups g SET intake_enabled=(j.value->'intake_enabled'='true'::jsonb) IS TRUE FROM jsonb_array_elements(p_groups) j
 WHERE g.tenant_id=(SELECT tenant_id FROM veo_accounts WHERE user_id=p_actor) AND g.chat_id=(j.value->>'chat_id')::bigint;
 RETURN result;
END $$;
CREATE TABLE veo_intake_auto_policy(
 tenant_id uuid PRIMARY KEY REFERENCES veo_tenants(id),enabled boolean NOT NULL DEFAULT true,enabled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 wait_minutes integer NOT NULL DEFAULT 60 CHECK(wait_minutes BETWEEN 1 AND 1440),accept_minutes integer NOT NULL DEFAULT 15 CHECK(accept_minutes BETWEEN 1 AND 60),
 wait_anchor text NOT NULL DEFAULT 'inquiry' CHECK(wait_anchor IN('inquiry','ready'))
);
INSERT INTO veo_intake_auto_policy(tenant_id) SELECT id FROM veo_tenants WHERE launch_at IS NOT NULL;
CREATE TABLE veo_intake_dispatch(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES veo_tenants(id),contact_id uuid NOT NULL UNIQUE REFERENCES contacts(id),
 page_id uuid NOT NULL REFERENCES pages(id),team_id uuid NOT NULL REFERENCES veo_teams(id),chat_id bigint NOT NULL CHECK(chat_id<0),
 arrived_at timestamptz NOT NULL,eligible_at timestamptz NOT NULL,announced_at timestamptz,announcement_message_id bigint,
 status text NOT NULL DEFAULT 'waiting' CHECK(status IN('waiting','offered','accepted','cancelled')),
 offer_id uuid REFERENCES veo_client_offers(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),last_error text
);
CREATE INDEX veo_intake_dispatch_due ON veo_intake_dispatch(tenant_id,eligible_at) WHERE status IN('waiting','offered');
CREATE TABLE veo_intake_dispatch_attempts(
 offer_id uuid PRIMARY KEY REFERENCES veo_client_offers(id),dispatch_id uuid NOT NULL REFERENCES veo_intake_dispatch(id),
 user_id uuid NOT NULL REFERENCES veo_accounts(user_id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),delivered_at timestamptz,telegram_message_id bigint
);
CREATE INDEX veo_intake_dispatch_worker ON veo_intake_dispatch_attempts(user_id,created_at DESC);
CREATE INDEX veo_intake_dispatch_attempt ON veo_intake_dispatch_attempts(dispatch_id,user_id,created_at DESC);
CREATE FUNCTION veo_dispatch_fresh_eligible(p_contact uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM contacts c JOIN pages pg ON pg.id=c.page_id AND pg.veo_enabled JOIN veo_intake_auto_policy p ON p.tenant_id=pg.veo_tenant_id AND p.enabled
 WHERE c.id=p_contact AND coalesce(c.first_interaction_at,c.created_at)>=p.enabled_at AND c.last_inbound_at IS NOT NULL
 AND c.pipeline_stage NOT IN('converted','order_created','not_qualified','opted_out')
 AND NOT EXISTS(SELECT 1 FROM veo_orders WHERE contact_id=c.id) AND NOT EXISTS(SELECT 1 FROM veo_closed_deals WHERE contact_id=c.id AND voided_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM veo_client_claims WHERE contact_id=c.id AND(user_id IS NOT NULL OR released_at IS NOT NULL))
 AND EXISTS(SELECT 1 FROM veo_team_telegram_pages r JOIN veo_teams t ON t.id=r.team_id AND t.tenant_id=p.tenant_id
 JOIN veo_telegram_groups g ON g.tenant_id=p.tenant_id AND g.chat_id=r.chat_id AND g.active AND g.intake_enabled
 WHERE r.page_id=c.page_id AND veo_can_page(t.manager_id,c.page_id)))
$$;

-- Availability must survive the one-hour client wait. Acceptance and /busy
-- still turn Ready off; Philippine midnight ends the current declaration.
DO $$ DECLARE definition text;old text:=$old$until_at:=least(at+interval '30 minutes',(((at AT TIME ZONE 'Asia/Manila')::date+1)::timestamp AT TIME ZONE 'Asia/Manila'));$old$;BEGIN
 definition:=pg_get_functiondef('veo_intake_action(uuid,text,jsonb)'::regprocedure);
 IF strpos(definition,old)=0 THEN RAISE EXCEPTION 'Readiness implementation changed';END IF;
 definition:=replace(definition,old,$new$until_at:=(((at AT TIME ZONE 'Asia/Manila')::date+1)::timestamp AT TIME ZONE 'Asia/Manila');$new$);
 EXECUTE definition;
END $$;

CREATE FUNCTION veo_dispatch_editor_allowed(p_user uuid,p_team uuid,p_page uuid,p_chat bigint,p_now timestamptz) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM veo_accounts a JOIN users u ON u.id=a.user_id AND u.is_active JOIN veo_teams t ON t.id=p_team AND t.tenant_id=a.tenant_id
 JOIN veo_intake_readiness r ON r.user_id=a.user_id AND r.status='ready' AND r.expires_at>p_now
 JOIN veo_telegram_memberships m ON m.user_id=a.user_id AND m.chat_id=p_chat JOIN veo_worker_mappings w ON w.user_id=m.user_id AND w.telegram_user_id=m.telegram_user_id
 LEFT JOIN veo_telegram_group_states s ON s.user_id=m.user_id AND s.chat_id=m.chat_id
 WHERE a.user_id=p_user AND a.active AND a.role IN('member','manager') AND t.manager_id=CASE WHEN a.role='manager' THEN a.user_id ELSE a.parent_id END
 AND veo_can_page(p_user,p_page) AND veo_staff_can_telegram_group(p_user,p_chat)
 AND EXISTS(SELECT 1 FROM veo_telegram_groups g WHERE g.tenant_id=a.tenant_id AND g.chat_id=p_chat AND g.active AND g.intake_enabled)
 AND ((s.observed_at>p_now-interval '10 minutes' AND s.payload->'membership_confirmed'='true'::jsonb AND s.payload->'is_bot'='false'::jsonb
 AND s.payload->>'membership' IN('member','administrator','creator','restricted_member')) OR(s.user_id IS NULL AND m.verified_at>p_now-interval '10 minutes'))
 AND veo_telegram_destination(p_team,p_page,p_user)->>'chat_id'=p_chat::text)
$$;

CREATE FUNCTION veo_automatic_intake_tick(p_tenant uuid,p_now timestamptz DEFAULT clock_timestamp()) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off SET plan_cache_mode=force_custom_plan AS $$
DECLARE policy veo_intake_auto_policy;d veo_intake_dispatch;inquiry record;route record;old veo_client_offers;worker uuid;owner uuid;result jsonb;ready_at timestamptz;
 announced integer:=0;offered integer:=0;cancelled integer:=0;BEGIN
 SELECT * INTO policy FROM veo_intake_auto_policy WHERE tenant_id=p_tenant AND enabled;
 IF NOT FOUND THEN RETURN jsonb_build_object('enabled',false);END IF;
 SELECT owner_id INTO owner FROM veo_tenants WHERE id=p_tenant AND launch_at IS NOT NULL;
 IF owner IS NULL THEN RAISE EXCEPTION 'Tenant is not launched';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('veo-intake:'||p_tenant::text,0));
 -- The activation cutoff excludes retained contacts and imported history. Only
 -- genuinely new customer inquiries can start an automatic editor rotation.
 FOR inquiry IN SELECT q.id,q.page_id,coalesce(x.first_interaction_at,x.created_at) arrived_at FROM veo_intake_contacts q JOIN contacts x ON x.id=q.id JOIN pages pg ON pg.id=q.page_id
  WHERE pg.veo_tenant_id=p_tenant AND pg.veo_enabled AND q.last_interaction_at>=policy.enabled_at AND coalesce(x.first_interaction_at,x.created_at)>=policy.enabled_at
  AND q.pipeline_stage NOT IN('converted','order_created','not_qualified','opted_out') AND x.last_inbound_at IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM veo_intake_dispatch WHERE contact_id=q.id)
  AND NOT EXISTS(SELECT 1 FROM veo_client_claims WHERE contact_id=q.id AND(user_id IS NOT NULL OR released_at IS NOT NULL))
  AND NOT EXISTS(SELECT 1 FROM veo_orders WHERE contact_id=q.id) AND NOT EXISTS(SELECT 1 FROM veo_closed_deals WHERE contact_id=q.id AND voided_at IS NULL)
  ORDER BY q.last_interaction_at,q.id LIMIT 30 LOOP
  SELECT t.id team_id,l.chat_id INTO route FROM veo_team_telegram_pages r JOIN veo_team_telegram_groups l USING(team_id,chat_id) JOIN veo_teams t ON t.id=r.team_id
   JOIN veo_telegram_groups g ON g.tenant_id=t.tenant_id AND g.chat_id=l.chat_id AND g.active AND g.intake_enabled JOIN veo_accounts a ON a.user_id=t.manager_id AND a.active
   WHERE r.page_id=inquiry.page_id AND t.tenant_id=p_tenant AND veo_can_page(t.manager_id,inquiry.page_id)
   ORDER BY EXISTS(SELECT 1 FROM veo_accounts w WHERE veo_dispatch_editor_allowed(w.user_id,t.id,inquiry.page_id,l.chat_id,p_now)) DESC,
    (SELECT max(created_at) FROM veo_intake_dispatch WHERE team_id=t.id) ASC NULLS FIRST,t.id LIMIT 1;
  IF FOUND THEN
   INSERT INTO veo_intake_dispatch(tenant_id,contact_id,page_id,team_id,chat_id,arrived_at,eligible_at)
    VALUES(p_tenant,inquiry.id,inquiry.page_id,route.team_id,route.chat_id,inquiry.arrived_at,inquiry.arrived_at+make_interval(mins=>policy.wait_minutes)) ON CONFLICT(contact_id) DO NOTHING;
   IF FOUND THEN announced:=announced+1;END IF;
  END IF;
 END LOOP;
 FOR d IN SELECT * FROM veo_intake_dispatch WHERE tenant_id=p_tenant AND status IN('waiting','offered') ORDER BY eligible_at,id LIMIT 50 FOR UPDATE LOOP
  IF EXISTS(SELECT 1 FROM veo_client_claims WHERE contact_id=d.contact_id AND user_id IS NOT NULL) THEN
   UPDATE veo_intake_dispatch SET status='accepted',last_error=NULL WHERE id=d.id;CONTINUE;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM contacts c JOIN veo_team_telegram_pages r ON r.team_id=d.team_id AND r.page_id=c.page_id AND r.chat_id=d.chat_id
    JOIN veo_telegram_groups g ON g.tenant_id=p_tenant AND g.chat_id=d.chat_id AND g.active AND g.intake_enabled
    WHERE c.id=d.contact_id AND c.pipeline_stage NOT IN('converted','order_created','not_qualified','opted_out') AND veo_can_page((SELECT manager_id FROM veo_teams WHERE id=d.team_id),c.page_id))
   OR EXISTS(SELECT 1 FROM veo_orders WHERE contact_id=d.contact_id) OR EXISTS(SELECT 1 FROM veo_closed_deals WHERE contact_id=d.contact_id AND voided_at IS NULL)
   OR EXISTS(SELECT 1 FROM veo_client_claims WHERE contact_id=d.contact_id AND released_at IS NOT NULL) THEN
   UPDATE veo_intake_dispatch SET status='cancelled',last_error='Inquiry eligibility or configured group changed' WHERE id=d.id;
   UPDATE veo_client_offers SET status='cancelled',ended_at=p_now WHERE id=d.offer_id AND status='pending';cancelled:=cancelled+1;CONTINUE;
  END IF;
  IF d.offer_id IS NOT NULL THEN
   SELECT * INTO old FROM veo_client_offers WHERE id=d.offer_id;
   IF old.status='pending' AND old.expires_at>p_now THEN CONTINUE;END IF;
   IF old.status IN('expired','pending') AND old.expires_at<=p_now THEN
    UPDATE veo_client_offers SET status='expired',ended_at=p_now WHERE id=old.id AND status='pending';
    IF EXISTS(SELECT 1 FROM veo_intake_dispatch_attempts WHERE offer_id=old.id AND delivered_at IS NOT NULL) THEN
     UPDATE veo_intake_readiness SET status='busy',updated_at=p_now WHERE user_id=old.offered_to AND status='ready' AND updated_at<=old.created_at;
    END IF;
   END IF;
   UPDATE veo_intake_dispatch SET status='waiting',offer_id=NULL WHERE id=d.id;
  END IF;
  IF d.announced_at IS NULL OR(policy.wait_anchor='inquiry' AND d.eligible_at>p_now) THEN CONTINUE;END IF;
  IF EXISTS(SELECT 1 FROM veo_client_offers WHERE contact_id=d.contact_id AND status='pending' AND expires_at>p_now) THEN CONTINUE;END IF;
  SELECT a.user_id INTO worker FROM veo_accounts a JOIN veo_intake_readiness r ON r.user_id=a.user_id
   WHERE veo_dispatch_editor_allowed(a.user_id,d.team_id,d.page_id,d.chat_id,p_now)
   AND(policy.wait_anchor='inquiry' OR r.updated_at<=p_now-make_interval(mins=>policy.wait_minutes))
   AND NOT EXISTS(SELECT 1 FROM veo_client_offers o WHERE o.offered_to=a.user_id AND o.status='pending' AND o.expires_at>p_now)
   AND NOT EXISTS(SELECT 1 FROM veo_intake_dispatch_attempts a2 WHERE a2.dispatch_id=d.id AND a2.user_id=a.user_id AND a2.created_at>=r.updated_at)
   ORDER BY(SELECT max(created_at) FROM veo_intake_dispatch_attempts WHERE user_id=a.user_id) ASC NULLS FIRST,r.updated_at,a.user_id LIMIT 1;
  IF worker IS NULL THEN UPDATE veo_intake_dispatch SET last_error='Waiting for an eligible Ready editor in this team and Telegram group' WHERE id=d.id;CONTINUE;END IF;
  BEGIN
   result:=veo_intake_action(owner,'offer',jsonb_build_object('request_id',gen_random_uuid(),'contact_id',d.contact_id,'user_id',worker,'reason','Automatic fresh inquiry allocation after the configured wait'));
   INSERT INTO veo_intake_dispatch_attempts(offer_id,dispatch_id,user_id) VALUES((result->>'offer_id')::uuid,d.id,worker);
   UPDATE veo_intake_dispatch SET status='offered',offer_id=(result->>'offer_id')::uuid,last_error=NULL WHERE id=d.id;offered:=offered+1;
  EXCEPTION WHEN OTHERS THEN UPDATE veo_intake_dispatch SET last_error='Editor availability changed; retry on the next scheduled run' WHERE id=d.id;
  END;
 END LOOP;
 RETURN jsonb_build_object('enabled',true,'new_announcements',announced,'offered',offered,'cancelled',cancelled);
END $$;

CREATE FUNCTION veo_intake_notice(p_tenant uuid,p_notice uuid,p_chat bigint) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d veo_intake_dispatch;c contacts;p pages;policy veo_intake_auto_policy;thread bigint;BEGIN
 SELECT * INTO d FROM veo_intake_dispatch WHERE id=p_notice AND tenant_id=p_tenant AND chat_id=p_chat AND status IN('waiting','offered');
 IF d.id IS NULL OR EXISTS(SELECT 1 FROM veo_client_claims WHERE contact_id=d.contact_id AND user_id IS NOT NULL) THEN RETURN NULL;END IF;
 SELECT * INTO c FROM contacts WHERE id=d.contact_id;SELECT * INTO p FROM pages WHERE id=d.page_id;
 SELECT * INTO policy FROM veo_intake_auto_policy WHERE tenant_id=p_tenant AND enabled;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT l.thread_id INTO thread FROM veo_team_telegram_groups l JOIN veo_team_telegram_pages r USING(team_id,chat_id) JOIN veo_telegram_groups g ON g.tenant_id=l.tenant_id AND g.chat_id=l.chat_id AND g.active AND g.intake_enabled
 WHERE l.team_id=d.team_id AND l.chat_id=p_chat AND r.page_id=d.page_id AND veo_can_page((SELECT manager_id FROM veo_teams WHERE id=d.team_id),d.page_id);
 IF NOT FOUND OR c.pipeline_stage IN('converted','order_created','not_qualified','opted_out') OR EXISTS(SELECT 1 FROM veo_orders WHERE contact_id=c.id) OR EXISTS(SELECT 1 FROM veo_closed_deals WHERE contact_id=c.id AND voided_at IS NULL) THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('notice_id',d.id,'chat_id',p_chat,'thread_id',thread,'text','New client inquiry: '||left(coalesce(c.name,'New client'),100)||E'\nPage: '||left(p.name,100)||
 E'\nThis is a fresh inquiry, not a Closed or Done Deal.\n'||CASE WHEN policy.wait_anchor='inquiry' THEN 'First editor offer after '||to_char(d.eligible_at AT TIME ZONE 'Asia/Manila','HH24:MI')||' PHT (one-hour inquiry wait).' ELSE 'Editor offer after an editor has been Ready for one hour.' END||
 E'\nUse /ready if you can take a client, or /busy if unavailable. The selected editor must accept within 15 minutes; otherwise another Ready editor receives the offer.',
 'reply_markup',jsonb_build_object('inline_keyboard',jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Ready','callback_data','cw:ready'),jsonb_build_object('text','Busy','callback_data','cw:busy')),jsonb_build_array(jsonb_build_object('text','Open client','url','https://veochatbot.vercel.app/dashboard/contacts/'||c.id::text||'?pageId='||p.id::text)))));
END $$;

CREATE FUNCTION veo_intake_notice_pending(p_tenant uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('notice_id',d.id,'chat_id',d.chat_id)),'[]') FROM(
 SELECT * FROM veo_intake_dispatch WHERE tenant_id=p_tenant AND announced_at IS NULL AND status IN('waiting','offered') ORDER BY created_at,id LIMIT 30) d
 WHERE veo_intake_notice(p_tenant,d.id,d.chat_id) IS NOT NULL
$$;
CREATE FUNCTION veo_ack_intake_notice(p_tenant uuid,p_notice uuid,p_chat bigint,p_message bigint) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_message<=0 THEN RETURN false;END IF;
 UPDATE veo_intake_dispatch SET announced_at=coalesce(announced_at,clock_timestamp()),announcement_message_id=coalesce(announcement_message_id,p_message)
 WHERE id=p_notice AND tenant_id=p_tenant AND chat_id=p_chat AND(announcement_message_id IS NULL OR announcement_message_id=p_message);
 RETURN FOUND;
END $$;
CREATE FUNCTION veo_ack_intake_offer(p_tenant uuid,p_offer uuid,p_chat bigint,p_message bigint,p_sent_at timestamptz DEFAULT clock_timestamp()) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a veo_intake_dispatch_attempts;until_at timestamptz;BEGIN
 SELECT x.* INTO a FROM veo_intake_dispatch_attempts x JOIN veo_intake_dispatch d ON d.id=x.dispatch_id AND d.tenant_id=p_tenant AND d.chat_id=p_chat WHERE x.offer_id=p_offer FOR UPDATE OF x;
 IF a.offer_id IS NULL THEN RETURN true;END IF;
 IF a.delivered_at IS NOT NULL THEN RETURN a.telegram_message_id=p_message;END IF;
 IF p_message<=0 OR p_sent_at<a.created_at-interval '1 minute' OR p_sent_at>clock_timestamp()+interval '1 minute' THEN RETURN false;END IF;
 SELECT least(p_sent_at+make_interval(mins=>p.accept_minutes),r.expires_at) INTO until_at FROM veo_intake_auto_policy p JOIN veo_intake_readiness r ON r.user_id=a.user_id WHERE p.tenant_id=p_tenant;
 UPDATE veo_client_offers SET expires_at=until_at WHERE id=p_offer AND tenant_id=p_tenant AND status='pending';
 IF NOT FOUND THEN RETURN true;END IF;
 UPDATE veo_intake_dispatch_attempts SET delivered_at=p_sent_at,telegram_message_id=p_message WHERE offer_id=p_offer;
 UPDATE veo_telegram_intake_requests SET expires_at=until_at WHERE offer_id=p_offer;
 UPDATE veo_telegram_intake_tokens SET expires_at=until_at WHERE request_id IN(SELECT id FROM veo_telegram_intake_requests WHERE offer_id=p_offer);
 RETURN true;
END $$;

ALTER FUNCTION veo_intake_action(uuid,text,jsonb) RENAME TO veo_intake_action_before_auto_dispatch;
CREATE FUNCTION veo_intake_action(p_actor uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d veo_intake_dispatch;policy veo_intake_auto_policy;BEGIN
 IF p_action IN('accept','offer') THEN
  IF NOT EXISTS(SELECT 1 FROM contacts WHERE id=(p_data->>'contact_id')::uuid AND veo_can_page(p_actor,page_id)) THEN RAISE EXCEPTION 'Client Page access denied' USING ERRCODE='42501';END IF;
  SELECT x.* INTO d FROM veo_intake_dispatch x JOIN veo_intake_auto_policy p ON p.tenant_id=x.tenant_id AND p.enabled WHERE x.contact_id=(p_data->>'contact_id')::uuid AND x.status IN('waiting','offered');
  IF d.id IS NULL AND veo_dispatch_fresh_eligible((p_data->>'contact_id')::uuid) THEN RAISE EXCEPTION 'This inquiry is in the automatic Telegram queue. Wait for your editor offer before accepting it';END IF;
  IF d.id IS NOT NULL THEN
   SELECT * INTO policy FROM veo_intake_auto_policy WHERE tenant_id=d.tenant_id;
   IF p_action='accept' AND nullif(p_data->>'offer_id','') IS NULL OR p_action='offer' AND(
    policy.wait_anchor='inquiry' AND d.eligible_at>clock_timestamp() OR policy.wait_anchor='ready' AND NOT EXISTS(
    SELECT 1 FROM veo_intake_readiness WHERE user_id=(p_data->>'user_id')::uuid AND status='ready' AND updated_at<=clock_timestamp()-make_interval(mins=>policy.wait_minutes)))
   THEN RAISE EXCEPTION 'This inquiry is in the automatic Telegram queue. Wait for your editor offer before accepting it';END IF;
  END IF;
 END IF;
 RETURN veo_intake_action_before_auto_dispatch(p_actor,p_action,p_data);
END $$;
ALTER FUNCTION veo_intake_page(uuid,text,uuid,text,integer) RENAME TO veo_intake_page_before_auto_dispatch;
CREATE FUNCTION veo_intake_page(p_actor uuid,p_view text DEFAULT 'pool',p_page uuid DEFAULT NULL,p_search text DEFAULT '',p_offset integer DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE result jsonb;BEGIN
 result:=veo_intake_page_before_auto_dispatch(p_actor,p_view,p_page,p_search,p_offset);
 RETURN result||jsonb_build_object('auto_policy',(SELECT jsonb_build_object('enabled',p.enabled,'wait_minutes',p.wait_minutes,'accept_minutes',p.accept_minutes,'wait_anchor',p.wait_anchor) FROM veo_intake_auto_policy p JOIN veo_accounts a ON a.tenant_id=p.tenant_id WHERE a.user_id=p_actor),
 'items',coalesce((SELECT jsonb_agg(i.value||jsonb_build_object('auto_assignment',coalesce((SELECT jsonb_build_object('status',d.status,'eligible_at',d.eligible_at,'announced_at',d.announced_at,'last_error',d.last_error) FROM veo_intake_dispatch d WHERE d.contact_id=(i.value->>'id')::uuid),
 (SELECT jsonb_build_object('status','waiting','eligible_at',coalesce(c.first_interaction_at,c.created_at)+make_interval(mins=>p.wait_minutes),'announced_at',NULL,'last_error','Waiting for the next scheduled Telegram announcement')
 FROM contacts c JOIN pages pg ON pg.id=c.page_id JOIN veo_intake_auto_policy p ON p.tenant_id=pg.veo_tenant_id WHERE c.id=(i.value->>'id')::uuid AND veo_dispatch_fresh_eligible(c.id))))) FROM jsonb_array_elements(result->'items') i),'[]'));
END $$;
DO $$ DECLARE tab text;fn record;BEGIN
 FOREACH tab IN ARRAY ARRAY['veo_intake_auto_policy','veo_intake_dispatch','veo_intake_dispatch_attempts'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,anon,authenticated',tab);EXECUTE format('GRANT ALL ON %I TO service_role',tab);
 END LOOP;
 FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_dispatch_editor_allowed','veo_dispatch_fresh_eligible','veo_automatic_intake_tick','veo_intake_notice','veo_intake_notice_pending','veo_ack_intake_notice','veo_ack_intake_offer','veo_intake_action','veo_intake_page','veo_sync_telegram_groups') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);
 END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
