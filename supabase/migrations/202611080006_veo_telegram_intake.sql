BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL jit=off;
CREATE TABLE veo_telegram_intake_requests(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES veo_tenants(id),actor_id uuid NOT NULL REFERENCES veo_accounts(user_id),chat_id bigint NOT NULL,
 kind text NOT NULL,context jsonb NOT NULL DEFAULT '{}',offer_id uuid,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',UNIQUE(offer_id,chat_id)
);
CREATE TABLE veo_telegram_intake_tokens(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),request_id uuid NOT NULL REFERENCES veo_telegram_intake_requests(id) ON DELETE CASCADE,
 action text NOT NULL,contact_id uuid,offer_id uuid,target_id uuid,expires_at timestamptz NOT NULL,
 result_request_id uuid REFERENCES veo_telegram_intake_requests(id) ON DELETE SET NULL,
 UNIQUE NULLS NOT DISTINCT(request_id,action,contact_id,offer_id,target_id)
);
CREATE INDEX veo_telegram_intake_request_expiry ON veo_telegram_intake_requests(expires_at);

CREATE FUNCTION veo_telegram_intake_context(p_tenant uuid,p_telegram bigint,p_chat bigint) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE actor uuid;n integer;a veo_accounts;ids uuid[];thread bigint;BEGIN
 SELECT count(*),(array_agg(w.user_id))[1] INTO n,actor FROM veo_accounts w JOIN veo_worker_mappings m USING(user_id) JOIN users u ON u.id=w.user_id AND u.is_active
 WHERE w.tenant_id=p_tenant AND w.active AND m.telegram_user_id=p_telegram AND(
  EXISTS(SELECT 1 FROM veo_telegram_memberships g WHERE g.user_id=w.user_id AND g.chat_id=p_chat AND g.telegram_user_id=p_telegram AND veo_staff_can_telegram_group(w.user_id,p_chat))
  OR(NOT EXISTS(SELECT 1 FROM veo_telegram_memberships WHERE user_id=w.user_id) AND veo_current_telegram_group(w.user_id)=p_chat AND EXISTS(SELECT 1 FROM veo_staff_telegram_groups WHERE user_id=w.user_id AND telegram_chat_id=p_chat)));
 IF n<>1 THEN RAISE EXCEPTION 'Ask the Head to verify your Telegram account, linked team group and Page access in Tokko' USING ERRCODE='42501';END IF;
 SELECT * INTO a FROM veo_accounts WHERE user_id=actor;
 SELECT coalesce(array_agg(p.id ORDER BY p.id),'{}') INTO ids FROM pages p WHERE veo_can_page(actor,p.id) AND EXISTS(
  SELECT 1 FROM veo_teams t WHERE t.tenant_id=p_tenant AND veo_can_page(t.manager_id,p.id)
  AND(a.role='owner' OR(a.role='team_leader' AND t.manager_id IN(SELECT veo_descendants(actor))) OR t.manager_id=CASE WHEN a.role='manager' THEN actor ELSE a.parent_id END)
  AND((NOT t.telegram_groups_managed AND t.telegram_chat_id=p_chat) OR EXISTS(SELECT 1 FROM veo_team_telegram_pages r WHERE r.team_id=t.id AND r.chat_id=p_chat AND r.page_id=p.id)));
 IF cardinality(ids)=0 THEN RAISE EXCEPTION 'No currently permitted Pages are routed to this group' USING ERRCODE='42501';END IF;
 SELECT l.thread_id INTO thread FROM veo_team_telegram_groups l JOIN veo_teams t ON t.id=l.team_id WHERE l.tenant_id=p_tenant AND l.chat_id=p_chat
  AND(a.role IN('owner','team_leader') AND t.manager_id IN(SELECT veo_descendants(actor)) OR t.manager_id=CASE WHEN a.role='manager' THEN actor ELSE a.parent_id END) ORDER BY t.id LIMIT 1;
 RETURN jsonb_build_object('actor_id',actor,'role',a.role,'page_ids',to_jsonb(ids),'thread_id',thread);
END $$;

CREATE FUNCTION veo_telegram_intake_token(p_request uuid,p_action text,p_contact uuid DEFAULT NULL,p_offer uuid DEFAULT NULL,p_target uuid DEFAULT NULL) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE token uuid;until_at timestamptz;BEGIN
 SELECT expires_at INTO until_at FROM veo_telegram_intake_requests WHERE id=p_request AND expires_at>now();IF NOT FOUND THEN RAISE EXCEPTION 'Assignment menu expired; use /clients again';END IF;
 INSERT INTO veo_telegram_intake_tokens(request_id,action,contact_id,offer_id,target_id,expires_at) VALUES(p_request,p_action,p_contact,p_offer,p_target,until_at)
 ON CONFLICT(request_id,action,contact_id,offer_id,target_id) DO UPDATE SET expires_at=EXCLUDED.expires_at RETURNING id INTO token;
 RETURN 'vi:'||token::text;
END $$;

CREATE FUNCTION veo_telegram_intake_pending(p_tenant uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
 SELECT coalesce(jsonb_agg(to_jsonb(o)),'[]') FROM(
 SELECT x.id offer_id,a.user_id,wm.telegram_user_id,(dest->>'chat_id')::bigint chat_id FROM veo_client_offers x JOIN veo_accounts a ON a.user_id=x.offered_to AND a.active
 JOIN veo_teams t ON t.tenant_id=a.tenant_id AND t.manager_id=CASE WHEN a.role='manager' THEN a.user_id ELSE a.parent_id END
 JOIN veo_worker_mappings wm ON wm.user_id=a.user_id LEFT JOIN veo_client_claims cc ON cc.contact_id=x.contact_id
 CROSS JOIN LATERAL(SELECT veo_telegram_destination(t.id,x.page_id,a.user_id) dest) d
 WHERE x.tenant_id=p_tenant AND x.status='pending' AND x.expires_at>now() AND dest->>'chat_id' IS NOT NULL
 AND cc.user_id IS NOT DISTINCT FROM x.previous_owner AND veo_intake_can_offer(x.offered_by,x.contact_id,a.user_id)
 ORDER BY x.created_at,x.id LIMIT 50) o
$$;

CREATE FUNCTION veo_telegram_intake(p_tenant uuid,p_telegram bigint,p_chat bigint,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off SET plan_cache_mode=force_custom_plan AS $$
DECLARE scope jsonb;actor uuid;req uuid;kind text;context jsonb:='{}';token veo_telegram_intake_tokens;r veo_telegram_intake_requests;offer veo_client_offers;
 ids uuid[];pg uuid;part jsonb;items jsonb:='[]';c jsonb;w jsonb;lines text;buttons jsonb:='[]';row_buttons jsonb;ready boolean;dest jsonb;target_team uuid;result jsonb;BEGIN
 scope:=veo_telegram_intake_context(p_tenant,p_telegram,p_chat);actor:=(scope->>'actor_id')::uuid;
 SELECT array_agg(value::uuid) INTO ids FROM jsonb_array_elements_text(scope->'page_ids');
 PERFORM pg_advisory_xact_lock(hashtextextended('veo-intake:'||p_tenant::text,0));
 IF p_action='render_offer' THEN
  SELECT * INTO offer FROM veo_client_offers WHERE id=(p_data->>'offer_id')::uuid AND tenant_id=p_tenant AND offered_to=actor;
  IF offer.id IS NULL OR offer.status<>'pending' OR offer.expires_at<=now() OR NOT(offer.page_id=ANY(ids)) OR NOT veo_intake_can_offer(offer.offered_by,offer.contact_id,actor)
   OR NOT EXISTS(SELECT 1 FROM veo_client_claims WHERE contact_id=offer.contact_id AND user_id IS NOT DISTINCT FROM offer.previous_owner) AND offer.previous_owner IS NOT NULL
  THEN RAISE EXCEPTION 'The offer expired, ended or its access changed' USING ERRCODE='42501';END IF;
  IF (SELECT user_id FROM veo_client_claims WHERE contact_id=offer.contact_id) IS DISTINCT FROM offer.previous_owner THEN RAISE EXCEPTION 'Client ownership changed' USING ERRCODE='42501';END IF;
  INSERT INTO veo_telegram_intake_requests(id,tenant_id,actor_id,chat_id,kind,context,offer_id,expires_at) VALUES(gen_random_uuid(),p_tenant,actor,p_chat,'offers',jsonb_build_object('contact_id',offer.contact_id),offer.id,offer.expires_at)
   ON CONFLICT(offer_id,chat_id) DO UPDATE SET expires_at=EXCLUDED.expires_at RETURNING id INTO req;
 ELSIF p_action='render' THEN req:=(p_data->>'request_id')::uuid;
 ELSE
  req:=(p_data->>'request_id')::uuid;IF req IS NULL THEN RAISE EXCEPTION 'A stable Telegram update ID is required';END IF;
  SELECT * INTO r FROM veo_telegram_intake_requests WHERE id=req;
  IF r.id IS NOT NULL THEN
   IF(r.tenant_id,r.actor_id,r.chat_id) IS DISTINCT FROM(p_tenant,actor,p_chat) THEN RAISE EXCEPTION 'Request belongs to another account' USING ERRCODE='42501';END IF;
   RETURN jsonb_build_object('request_id',req,'chat_id',p_chat,'telegram_user_id',p_telegram);
  END IF;
  kind:=p_action;
  IF p_action='callback' THEN
   SELECT t.* INTO token FROM veo_telegram_intake_tokens t JOIN veo_telegram_intake_requests x ON x.id=t.request_id WHERE t.id=(p_data->>'token_id')::uuid AND x.actor_id=actor AND x.chat_id=p_chat AND x.tenant_id=p_tenant AND t.expires_at>now() FOR UPDATE OF t;
   IF token.id IS NULL THEN RAISE EXCEPTION 'This button belongs to another person or has expired; use /clients for a fresh menu' USING ERRCODE='42501';END IF;
   IF token.result_request_id IS NOT NULL THEN RETURN jsonb_build_object('request_id',token.result_request_id,'chat_id',p_chat,'telegram_user_id',p_telegram);END IF;
   IF token.contact_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contacts WHERE id=token.contact_id AND page_id=ANY(ids)) THEN RAISE EXCEPTION 'Client Page access changed' USING ERRCODE='42501';END IF;
   kind:=token.action;context:=jsonb_strip_nulls(jsonb_build_object('contact_id',token.contact_id));
  END IF;
  IF kind IN('ready','busy') THEN
   PERFORM veo_intake_action(actor,'readiness',jsonb_build_object('request_id',req,'status',kind,'source','telegram'));kind:='status';
  ELSIF kind IN('accept','decline','cancel','offer') THEN
   IF token.id IS NULL THEN RAISE EXCEPTION 'Use the current assignment buttons';END IF;
   PERFORM veo_intake_action(actor,kind,jsonb_build_object('request_id',req,'contact_id',token.contact_id,'offer_id',token.offer_id,'user_id',token.target_id,'reason','Telegram handover requested by the current supervisor or client owner','source','telegram'));
   IF kind='accept' THEN kind:='assigned';ELSE context:=context||jsonb_build_object('notice',CASE WHEN kind='offer' THEN 'Client offer recorded. Assignments change only when the worker accepts; sales keep their original seller.' ELSE 'Offer updated.' END);kind:='notice';END IF;
  ELSIF kind NOT IN('pool','offers','assigned','reassign','choose_worker') THEN RAISE EXCEPTION 'Unknown Telegram assignment command';END IF;
  INSERT INTO veo_telegram_intake_requests(id,tenant_id,actor_id,chat_id,kind,context) VALUES(req,p_tenant,actor,p_chat,kind,context);
  INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value,reason) VALUES(p_tenant,actor,'telegram_intake',coalesce(token.contact_id,actor),jsonb_build_object('request_id',req,'chat_id',p_chat,'command',coalesce(token.action,p_action)),'Existing Jaucian bot; current account, group and Page authorization checked');
  IF token.id IS NOT NULL THEN UPDATE veo_telegram_intake_tokens SET result_request_id=req WHERE id=token.id;END IF;
  RETURN jsonb_build_object('request_id',req,'chat_id',p_chat,'telegram_user_id',p_telegram);
 END IF;
 SELECT * INTO r FROM veo_telegram_intake_requests WHERE id=req AND tenant_id=p_tenant AND actor_id=actor AND chat_id=p_chat AND expires_at>now();
 IF r.id IS NULL THEN RAISE EXCEPTION 'Assignment menu expired or its access changed' USING ERRCODE='42501';END IF;
 IF r.context->>'contact_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contacts WHERE id=(r.context->>'contact_id')::uuid AND page_id=ANY(ids)) THEN RAISE EXCEPTION 'Client Page access changed' USING ERRCODE='42501';END IF;
 ready:=EXISTS(SELECT 1 FROM veo_intake_readiness WHERE user_id=actor AND status='ready' AND expires_at>now());
 lines:='Tokko / VEO · '||(SELECT left(coalesce(name,'Worker'),80) FROM users WHERE id=actor)||E'\nStatus: '||CASE WHEN ready THEN 'Ready until '||(SELECT to_char(expires_at AT TIME ZONE 'Asia/Manila','HH24:MI') FROM veo_intake_readiness WHERE user_id=actor)||' PHT' ELSE 'Busy / Ready expired' END||E'\nReady/Busy is shared with Tokko. Tomorrow attendance still uses Jaucian’s poll.';
 IF r.kind='notice' THEN lines:=lines||E'\n'||(r.context->>'notice');
 ELSIF r.kind='choose_worker' THEN
  SELECT to_jsonb(x) INTO c FROM contacts x WHERE x.id=(r.context->>'contact_id')::uuid AND x.page_id=ANY(ids);
  part:=veo_intake_page(actor,'assigned',(c->>'page_id')::uuid,'',0);
  lines:=lines||E'\nOffer / reassign: '||coalesce(c->>'name','Unknown client')||E'\nChoose a Ready worker. The current owner keeps the client until acceptance.';
  FOR w IN SELECT value FROM jsonb_array_elements(part->'roster') WHERE value->'ready'='true'::jsonb LOOP
   IF NOT veo_intake_can_offer(actor,(c->>'id')::uuid,(w->>'id')::uuid) OR (w->>'id')::uuid=(SELECT user_id FROM veo_client_claims WHERE contact_id=(c->>'id')::uuid) THEN CONTINUE;END IF;
   SELECT id INTO target_team FROM veo_teams WHERE manager_id=(SELECT CASE WHEN role='manager' THEN user_id ELSE parent_id END FROM veo_accounts WHERE user_id=(w->>'id')::uuid);
   dest:=veo_telegram_destination(target_team,(c->>'page_id')::uuid,(w->>'id')::uuid);IF dest->>'chat_id' IS NULL THEN CONTINUE;END IF;
   buttons:=buttons||jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Offer to '||left(coalesce(w->>'name','Worker'),45),'callback_data',veo_telegram_intake_token(req,'offer',(c->>'id')::uuid,NULL,(w->>'id')::uuid))));
   IF jsonb_array_length(buttons)>=10 THEN EXIT;END IF;
  END LOOP;
  IF jsonb_array_length(buttons)=0 THEN lines:=lines||E'\nNo Ready, verified workers are currently eligible. Ask a supervisor or use Tokko.';END IF;
 ELSIF r.kind<>'status' THEN
  FOREACH pg IN ARRAY ids LOOP
   part:=veo_intake_page(actor,CASE WHEN r.kind='reassign' THEN 'assigned' ELSE r.kind END,pg,coalesce(r.context->>'contact_id',''),0);items:=items||(part->'items');
  END LOOP;
  lines:=lines||E'\n'||CASE r.kind WHEN 'pool' THEN 'Available clients (up to 10)' WHEN 'offers' THEN 'Current offers' WHEN 'reassign' THEN 'Choose an assigned client to hand over' ELSE 'Accepted clients' END;
  FOR c IN SELECT value FROM jsonb_array_elements(items) ORDER BY value->>'last_interaction_at' DESC,value->>'id' LIMIT 10 LOOP
   lines:=lines||E'\n• '||left(coalesce(c->>'name','Unknown client'),70)||' / '||left(coalesce(c->>'page_name','Unknown Page'),60)||' · '||coalesce(c->>'pipeline_stage','Unknown stage');row_buttons:='[]';
   IF r.kind='pool' AND scope->>'role' IN('member','manager') OR c->>'offered_to'=actor::text AND c->'offer_authorized'='true'::jsonb THEN
    row_buttons:=row_buttons||jsonb_build_array(jsonb_build_object('text','Accept · '||left(coalesce(c->>'name','Client'),35),'callback_data',veo_telegram_intake_token(req,'accept',(c->>'id')::uuid,nullif(c->>'offer_id','')::uuid,NULL)));
   END IF;
   IF c->'can_offer'='true'::jsonb THEN row_buttons:=row_buttons||jsonb_build_array(jsonb_build_object('text','Offer / reassign','callback_data',veo_telegram_intake_token(req,'choose_worker',(c->>'id')::uuid,NULL,NULL)));END IF;
   IF c->>'offered_to'=actor::text THEN row_buttons:=row_buttons||jsonb_build_array(jsonb_build_object('text','Decline','callback_data',veo_telegram_intake_token(req,'decline',(c->>'id')::uuid,(c->>'offer_id')::uuid,NULL)));END IF;
   IF jsonb_array_length(row_buttons)>0 THEN buttons:=buttons||jsonb_build_array(row_buttons);END IF;
  END LOOP;
  IF jsonb_array_length(items)=0 THEN lines:=lines||E'\nNo matching clients. Use Tokko for full search and history.';END IF;
 END IF;
 IF scope->>'role' IN('member','manager') THEN buttons:=buttons||jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Ready','callback_data',veo_telegram_intake_token(req,'ready')),jsonb_build_object('text','Busy','callback_data',veo_telegram_intake_token(req,'busy'))));END IF;
 buttons:=buttons||jsonb_build_array(jsonb_build_array(jsonb_build_object('text','New clients','callback_data',veo_telegram_intake_token(req,'pool')),jsonb_build_object('text','Offers','callback_data',veo_telegram_intake_token(req,'offers')),jsonb_build_object('text','My clients','callback_data',veo_telegram_intake_token(req,'assigned'))),jsonb_build_array(jsonb_build_object('text','Reassign','callback_data',veo_telegram_intake_token(req,'reassign')),jsonb_build_object('text','Open Tokko','url','https://veochatbot.vercel.app/dashboard/workspace?view=new_clients')));
 RETURN jsonb_build_object('request_id',req,'chat_id',p_chat,'telegram_user_id',p_telegram,'thread_id',scope->'thread_id','text',left(lines,3400),'reply_markup',jsonb_build_object('inline_keyboard',buttons));
END $$;
CREATE FUNCTION veo_telegram_intake_maintenance() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE removed integer;BEGIN
 WITH old AS(SELECT id FROM veo_telegram_intake_requests WHERE expires_at<now()-interval '1 day' ORDER BY expires_at LIMIT 500)
 DELETE FROM veo_telegram_intake_requests r USING old WHERE r.id=old.id;
 GET DIAGNOSTICS removed=ROW_COUNT;RETURN removed;
END $$;
DO $$ DECLARE tab text;fn record;BEGIN
 FOREACH tab IN ARRAY ARRAY['veo_telegram_intake_requests','veo_telegram_intake_tokens'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,anon,authenticated',tab);EXECUTE format('GRANT ALL ON %I TO service_role',tab);END LOOP;
 FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_telegram_intake_context','veo_telegram_intake_token','veo_telegram_intake_pending','veo_telegram_intake','veo_telegram_intake_maintenance') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);
 END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
