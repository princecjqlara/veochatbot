BEGIN;
CREATE TABLE veo_intake_readiness(
 user_id uuid PRIMARY KEY REFERENCES veo_accounts(user_id),tenant_id uuid NOT NULL REFERENCES veo_tenants(id),
 status text NOT NULL CHECK(status IN('ready','busy')),expires_at timestamptz NOT NULL,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),request_id uuid NOT NULL
);
CREATE TABLE veo_client_offers(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES veo_tenants(id),page_id uuid NOT NULL REFERENCES pages(id),contact_id uuid NOT NULL REFERENCES contacts(id),
 offered_to uuid NOT NULL REFERENCES veo_accounts(user_id),offered_by uuid NOT NULL REFERENCES veo_accounts(user_id),previous_owner uuid REFERENCES veo_accounts(user_id),
 status text NOT NULL CHECK(status IN('pending','accepted','declined','cancelled','expired')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 accepted_at timestamptz,ended_at timestamptz,reason text
);
CREATE UNIQUE INDEX veo_client_offer_pending ON veo_client_offers(contact_id) WHERE status='pending';
CREATE INDEX veo_client_offer_recipient ON veo_client_offers(tenant_id,offered_to,status,expires_at);
-- Existing idx_contacts_page_last_interaction and
-- idx_contacts_conversion_activity cover intake activity scans.
ALTER TABLE veo_intake_readiness ENABLE ROW LEVEL SECURITY;ALTER TABLE veo_client_offers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON veo_intake_readiness,veo_client_offers FROM PUBLIC,anon,authenticated;
GRANT ALL ON veo_intake_readiness,veo_client_offers TO service_role;

CREATE FUNCTION veo_intake_recipient(p_actor uuid,p_worker uuid,p_page uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM veo_accounts a JOIN veo_accounts w ON w.user_id=p_worker AND w.tenant_id=a.tenant_id AND w.active AND w.role IN('member','manager')
 WHERE a.user_id=p_actor AND a.active AND veo_can_page(a.user_id,p_page) AND veo_can_page(w.user_id,p_page)
 AND(w.user_id IN(SELECT veo_descendants(a.user_id)) OR(a.role='member' AND(w.user_id=a.parent_id OR(w.role='member' AND w.parent_id=a.parent_id)))))
$$;
CREATE FUNCTION veo_intake_can_offer(p_actor uuid,p_contact uuid,p_worker uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM veo_accounts a JOIN contacts c ON c.id=p_contact LEFT JOIN veo_client_claims cc ON cc.contact_id=c.id
 JOIN veo_tenants t ON t.id=a.tenant_id
 WHERE a.user_id=p_actor AND a.active AND veo_intake_recipient(p_actor,p_worker,c.page_id)
 AND c.pipeline_stage NOT IN('not_qualified','opted_out')
 AND((cc.user_id IS NULL AND cc.released_at IS NULL AND a.role<>'member' AND c.last_interaction_at>=t.launch_at
 AND NOT EXISTS(SELECT 1 FROM veo_orders WHERE contact_id=c.id) AND NOT EXISTS(SELECT 1 FROM veo_closed_deals WHERE contact_id=c.id AND voided_at IS NULL))
 OR(cc.user_id IS NOT NULL AND((a.role<>'member' AND cc.user_id IN(SELECT veo_descendants(p_actor)))
 OR(a.role='member' AND cc.user_id=p_actor AND NOT EXISTS(SELECT 1 FROM veo_orders WHERE contact_id=c.id)
 AND NOT EXISTS(SELECT 1 FROM veo_closed_deals WHERE contact_id=c.id AND voided_at IS NULL)))))
 )
$$;

CREATE FUNCTION veo_intake_action(p_actor uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a veo_accounts;w veo_accounts;c contacts;claim veo_client_claims;offer veo_client_offers;result jsonb;req uuid;target uuid;at timestamptz;until_at timestamptz;before_claim jsonb;BEGIN
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;
 IF a.user_id IS NULL OR NOT EXISTS(SELECT 1 FROM veo_tenants WHERE id=a.tenant_id AND launch_at IS NOT NULL) THEN RAISE EXCEPTION 'Workspace access denied' USING ERRCODE='42501';END IF;
 req:=(p_data->>'request_id')::uuid;IF req IS NULL THEN RAISE EXCEPTION 'A stable request ID is required';END IF;
 IF length(coalesce(p_data->>'reason',''))>500 THEN RAISE EXCEPTION 'Reassignment reasons must be at most 500 characters';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('veo-intake:'||a.tenant_id::text,0));at:=clock_timestamp();
 IF p_action='readiness' THEN
  IF a.role NOT IN('member','manager') OR p_data->>'status' NOT IN('ready','busy') OR p_data->>'status' IS NULL THEN RAISE EXCEPTION 'Selling workers may choose Ready or Busy';END IF;
  PERFORM 1 FROM veo_accounts WHERE user_id=p_actor AND active FOR UPDATE;
  IF EXISTS(SELECT 1 FROM veo_intake_readiness WHERE user_id=p_actor AND request_id=req) THEN RETURN jsonb_build_object('saved',true,'duplicate',true);END IF;
  until_at:=least(at+interval '30 minutes',(((at AT TIME ZONE 'Asia/Manila')::date+1)::timestamp AT TIME ZONE 'Asia/Manila'));
  INSERT INTO veo_intake_readiness(user_id,tenant_id,status,expires_at,updated_at,request_id) VALUES(p_actor,a.tenant_id,p_data->>'status',until_at,at,req)
  ON CONFLICT(user_id) DO UPDATE SET status=EXCLUDED.status,expires_at=EXCLUDED.expires_at,updated_at=EXCLUDED.updated_at,request_id=EXCLUDED.request_id;
  IF p_data->>'status'='busy' THEN UPDATE veo_client_offers SET status='cancelled',ended_at=at WHERE offered_to=p_actor AND status='pending';END IF;
  INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value) VALUES(a.tenant_id,p_actor,'intake_readiness',p_actor,jsonb_build_object('status',p_data->>'status','expires_at',until_at));
  RETURN jsonb_build_object('saved',true,'status',p_data->>'status','expires_at',until_at);
 END IF;
 IF p_action NOT IN('offer','accept','decline','cancel') THEN RAISE EXCEPTION 'Unknown intake action';END IF;
 SELECT * INTO c FROM contacts WHERE id=(p_data->>'contact_id')::uuid FOR UPDATE;
 IF c.id IS NULL OR NOT veo_can_page(p_actor,c.page_id) THEN RAISE EXCEPTION 'Client Page access denied' USING ERRCODE='42501';END IF;
 SELECT * INTO claim FROM veo_client_claims WHERE contact_id=c.id FOR UPDATE;before_claim:=to_jsonb(claim);
 IF p_action IN('decline','cancel') THEN
  SELECT * INTO offer FROM veo_client_offers WHERE id=(p_data->>'offer_id')::uuid AND contact_id=c.id AND tenant_id=a.tenant_id FOR UPDATE;
  IF offer.id IS NULL OR(p_action='decline' AND offer.offered_to<>p_actor) OR(p_action='cancel' AND offer.offered_by<>p_actor AND NOT(a.role<>'member' AND offer.offered_to IN(SELECT veo_descendants(p_actor)))) THEN RAISE EXCEPTION 'Offer access denied' USING ERRCODE='42501';END IF;
  IF offer.status<>'pending' THEN RETURN jsonb_build_object('saved',true,'status',offer.status,'duplicate',true);END IF;
  UPDATE veo_client_offers SET status=CASE WHEN p_action='decline' THEN 'declined' ELSE 'cancelled' END,ended_at=at WHERE id=offer.id;
  INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value) VALUES(a.tenant_id,p_actor,'intake_'||p_action,c.id,jsonb_build_object('offer_id',offer.id));
  RETURN jsonb_build_object('saved',true);
 END IF;
 IF p_action='offer' THEN
  target:=(p_data->>'user_id')::uuid;
  IF NOT veo_intake_can_offer(p_actor,c.id,target) THEN RAISE EXCEPTION 'Assign only authorized clients and workers in your branch and Pages' USING ERRCODE='42501';END IF;
  IF claim.user_id=target THEN RAISE EXCEPTION 'This client is already assigned to that worker';END IF;
  IF claim.user_id IS NOT NULL AND length(btrim(coalesce(p_data->>'reason','')))<3 THEN RAISE EXCEPTION 'Enter a reassignment reason of at least 3 characters';END IF;
  SELECT * INTO w FROM veo_accounts WHERE user_id=target AND active FOR UPDATE;
  IF w.user_id IS NULL THEN RAISE EXCEPTION 'Worker access changed' USING ERRCODE='42501';END IF;
  SELECT * INTO offer FROM veo_client_offers WHERE id=req;
  IF offer.id IS NOT NULL THEN
   IF offer.offered_by=p_actor AND offer.offered_to=target AND offer.contact_id=c.id THEN RETURN jsonb_build_object('saved',true,'offer_id',offer.id,'status',offer.status,'duplicate',true);END IF;
   RAISE EXCEPTION 'Request ID already used' USING ERRCODE='23505';
  END IF;
  SELECT expires_at INTO until_at FROM veo_intake_readiness WHERE user_id=target AND status='ready' AND expires_at>at;
  IF until_at IS NULL THEN RAISE EXCEPTION 'The selected worker is Busy or their Ready status expired';END IF;
  IF EXISTS(SELECT 1 FROM veo_client_offers old WHERE old.contact_id=c.id AND old.status='pending' AND old.expires_at>at
   AND NOT(old.offered_by=p_actor OR(a.role<>'member' AND old.offered_to IN(SELECT veo_descendants(p_actor)) AND(old.previous_owner IS NULL OR old.previous_owner IN(SELECT veo_descendants(p_actor))))))
  THEN RAISE EXCEPTION 'Another branch or supervisor has reserved this client' USING ERRCODE='42501';END IF;
  UPDATE veo_client_offers SET status='cancelled',ended_at=at WHERE contact_id=c.id AND status='pending';
  INSERT INTO veo_client_offers(id,tenant_id,page_id,contact_id,offered_to,offered_by,previous_owner,status,expires_at,reason)
  VALUES(req,a.tenant_id,c.page_id,c.id,target,p_actor,claim.user_id,'pending',least(until_at,at+interval '15 minutes'),nullif(btrim(p_data->>'reason'),''));
  INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value,reason) VALUES(a.tenant_id,p_actor,'intake_offer',c.id,jsonb_build_object('offer_id',req,'offered_to',target,'previous_owner',claim.user_id),p_data->>'reason');
  RETURN jsonb_build_object('saved',true,'offer_id',req,'status','pending');
 END IF;
 -- Accept never grants Page access or changes a recorded seller/payment.
 IF a.role NOT IN('member','manager') THEN RAISE EXCEPTION 'Only a selling worker can accept clients';END IF;
 PERFORM 1 FROM veo_accounts WHERE user_id=p_actor AND active FOR UPDATE;
 IF nullif(p_data->>'offer_id','') IS NOT NULL THEN
  SELECT * INTO offer FROM veo_client_offers WHERE id=(p_data->>'offer_id')::uuid AND tenant_id=a.tenant_id AND contact_id=c.id AND offered_to=p_actor FOR UPDATE;
  IF offer.id IS NULL THEN RAISE EXCEPTION 'This offer is not assigned to you' USING ERRCODE='42501';END IF;
  IF offer.status='accepted' AND claim.user_id=p_actor THEN RETURN jsonb_build_object('saved',true,'duplicate',true,'contact_id',c.id);END IF;
  IF offer.status<>'pending' OR offer.expires_at<=at THEN RAISE EXCEPTION 'The offer ended or expired. Ask for a new offer';END IF;
  IF claim.user_id IS DISTINCT FROM offer.previous_owner OR NOT veo_intake_can_offer(offer.offered_by,c.id,p_actor) THEN RAISE EXCEPTION 'Assignment or supervisor/Page access changed. Request a new offer' USING ERRCODE='42501';END IF;
 ELSE
  SELECT * INTO offer FROM veo_client_offers WHERE id=req;
  IF offer.id IS NOT NULL THEN
   IF offer.offered_to=p_actor AND offer.contact_id=c.id AND offer.status='accepted' AND claim.user_id=p_actor THEN RETURN jsonb_build_object('saved',true,'duplicate',true);END IF;
   RAISE EXCEPTION 'Request ID already used' USING ERRCODE='23505';
  END IF;
  IF claim.user_id IS NOT NULL OR claim.released_at IS NOT NULL OR c.last_interaction_at IS NULL OR c.last_interaction_at<(SELECT launch_at FROM veo_tenants WHERE id=a.tenant_id)
  OR c.pipeline_stage IN('not_qualified','opted_out') OR EXISTS(SELECT 1 FROM veo_orders WHERE contact_id=c.id) OR EXISTS(SELECT 1 FROM veo_closed_deals WHERE contact_id=c.id AND voided_at IS NULL)
  OR EXISTS(SELECT 1 FROM veo_client_offers WHERE contact_id=c.id AND status='pending' AND expires_at>at) THEN RAISE EXCEPTION 'Client is assigned, reserved, or not in the new-client queue' USING ERRCODE='42501';END IF;
  UPDATE veo_client_offers SET status='expired',ended_at=at WHERE contact_id=c.id AND status='pending' AND expires_at<=at;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM veo_intake_readiness WHERE user_id=p_actor AND status='ready' AND expires_at>at) THEN RAISE EXCEPTION 'Choose Ready before accepting a client';END IF;
 IF NOT EXISTS(SELECT 1 FROM veo_teams WHERE manager_id=CASE WHEN a.role='manager' THEN p_actor ELSE a.parent_id END AND tenant_id=a.tenant_id) THEN RAISE EXCEPTION 'Assign this worker to a manager team first';END IF;
 IF offer.id IS NULL THEN
  INSERT INTO veo_client_offers(id,tenant_id,page_id,contact_id,offered_to,offered_by,status,expires_at,accepted_at) VALUES(req,a.tenant_id,c.page_id,c.id,p_actor,p_actor,'accepted',at,at);
 ELSE UPDATE veo_client_offers SET status='accepted',accepted_at=at WHERE id=offer.id;END IF;
 INSERT INTO veo_client_claims(contact_id,tenant_id,page_id,user_id,previous_user_id,claimed_at)
 VALUES(c.id,a.tenant_id,c.page_id,p_actor,claim.user_id,at)
 ON CONFLICT(contact_id) DO UPDATE SET user_id=EXCLUDED.user_id,previous_user_id=EXCLUDED.previous_user_id,claimed_at=at,released_at=NULL,release_reason=NULL RETURNING to_jsonb(veo_client_claims.*) INTO result;
 INSERT INTO veo_order_work(order_id,assignee_id,updated_by,updated_at)
 SELECT o.id,p_actor,p_actor,at FROM veo_orders o LEFT JOIN veo_order_work ow ON ow.order_id=o.id
 WHERE o.contact_id=c.id AND coalesce(ow.status,'working')<>'delivered' AND(coalesce(ow.assignee_id,o.seller_id)=claim.user_id)
 ON CONFLICT(order_id) DO UPDATE SET assignee_id=p_actor,updated_by=p_actor,updated_at=at;
 PERFORM set_contact_bot_permission(c.page_id,c.id,p_actor,false);
 UPDATE veo_intake_readiness SET status='busy',updated_at=at WHERE user_id=p_actor;
 UPDATE veo_client_offers SET status='cancelled',ended_at=at WHERE offered_to=p_actor AND status='pending';
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value,reason) VALUES(a.tenant_id,p_actor,'client_assignment',c.id,before_claim,result||jsonb_build_object('offer_id',coalesce(offer.id,req),'offered_by',coalesce(offer.offered_by,p_actor)),coalesce(offer.reason,'Client accepted in Tokko'));
 RETURN result||jsonb_build_object('saved',true,'readiness','busy');
END $$;

CREATE FUNCTION veo_intake_page(p_actor uuid,p_view text DEFAULT 'pool',p_page uuid DEFAULT NULL,p_search text DEFAULT '',p_offset integer DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit='off' SET plan_cache_mode='force_custom_plan' AS $$
DECLARE a veo_accounts;launched timestamptz;result jsonb;BEGIN
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;SELECT launch_at INTO launched FROM veo_tenants WHERE id=a.tenant_id;
 IF a.user_id IS NULL OR launched IS NULL OR(p_page IS NOT NULL AND NOT veo_can_page(p_actor,p_page)) THEN RAISE EXCEPTION 'New-client access denied' USING ERRCODE='42501';END IF;
 IF p_view NOT IN('pool','offers','assigned') OR length(p_search)>200 OR p_offset<0 OR p_offset>100000 THEN RAISE EXCEPTION 'Invalid new-client filters';END IF;
 WITH visible_pages AS MATERIALIZED(SELECT id FROM pages WHERE veo_can_page(p_actor,id) AND(p_page IS NULL OR id=p_page)),
 candidates AS MATERIALIZED(
 SELECT c.id,c.page_id,c.name,c.psid,c.pipeline_stage,c.last_interaction_at,pg.name page_name,cc.user_id owner_id,u.name owner_name,
 o.id offer_id,o.offered_to,o.offered_by,o.expires_at offer_expires_at,ou.name offered_to_name,
 CASE WHEN o.id IS NOT NULL THEN cc.user_id IS NOT DISTINCT FROM o.previous_owner AND veo_intake_can_offer(o.offered_by,c.id,o.offered_to) ELSE false END offer_authorized,
 (o.id IS NULL OR o.offered_by=p_actor OR(a.role<>'member' AND o.offered_to IN(SELECT veo_descendants(p_actor)) AND(o.previous_owner IS NULL OR o.previous_owner IN(SELECT veo_descendants(p_actor))))) may_replace_offer,
 EXISTS(SELECT 1 FROM veo_orders WHERE contact_id=c.id) OR EXISTS(SELECT 1 FROM veo_closed_deals WHERE contact_id=c.id AND voided_at IS NULL) has_sales
 FROM visible_pages vp JOIN contacts c ON c.page_id=vp.id JOIN pages pg ON pg.id=c.page_id
 LEFT JOIN veo_client_claims cc ON cc.contact_id=c.id LEFT JOIN users u ON u.id=cc.user_id
 LEFT JOIN veo_client_offers o ON o.contact_id=c.id AND o.status='pending' AND o.expires_at>now() LEFT JOIN users ou ON ou.id=o.offered_to
 WHERE(p_search='' OR strpos(lower(concat_ws(' ',c.id::text,c.name,c.psid,pg.name)),lower(p_search))>0)
 AND CASE p_view
 WHEN 'pool' THEN cc.user_id IS NULL AND cc.released_at IS NULL AND o.id IS NULL AND c.last_interaction_at>=launched AND c.pipeline_stage NOT IN('not_qualified','opted_out')
 AND NOT EXISTS(SELECT 1 FROM veo_orders WHERE contact_id=c.id) AND NOT EXISTS(SELECT 1 FROM veo_closed_deals WHERE contact_id=c.id AND voided_at IS NULL)
 WHEN 'offers' THEN o.offered_to=p_actor OR(a.role<>'member' AND o.offered_to IN(SELECT veo_descendants(p_actor)))
 ELSE cc.user_id IN(SELECT veo_descendants(p_actor)) END),
 roster AS MATERIALIZED(SELECT w.user_id id,u.name,w.role,
 EXISTS(SELECT 1 FROM veo_intake_readiness r WHERE r.user_id=w.user_id AND r.status='ready' AND r.expires_at>now()) ready,
 (SELECT expires_at FROM veo_intake_readiness WHERE user_id=w.user_id) ready_until,
 ARRAY(SELECT vp.id FROM visible_pages vp WHERE veo_can_page(w.user_id,vp.id)) page_ids
 FROM veo_accounts w JOIN users u ON u.id=w.user_id WHERE w.tenant_id=a.tenant_id AND w.active AND w.role IN('member','manager')
 AND(w.user_id IN(SELECT veo_descendants(p_actor)) OR(a.role='member' AND(w.user_id=a.parent_id OR(w.role='member' AND w.parent_id=a.parent_id)))))
 SELECT jsonb_build_object('as_of',clock_timestamp(),'role',a.role,'can_sell',a.role IN('member','manager'),
 'readiness',jsonb_build_object('ready',EXISTS(SELECT 1 FROM veo_intake_readiness WHERE user_id=p_actor AND status='ready' AND expires_at>now()),'expires_at',(SELECT expires_at FROM veo_intake_readiness WHERE user_id=p_actor)),
 'roster',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY name,id) FROM roster r),'[]'),
 'total',(SELECT count(*) FROM candidates),'items',coalesce((SELECT jsonb_agg(to_jsonb(c)||jsonb_build_object('can_offer',c.may_replace_offer AND c.pipeline_stage NOT IN('not_qualified','opted_out') AND((a.role<>'member' AND(c.owner_id IS NULL OR c.owner_id IN(SELECT veo_descendants(p_actor)))) OR(c.owner_id=p_actor AND NOT c.has_sales))) ORDER BY c.last_interaction_at DESC,c.id)
 FROM(SELECT * FROM candidates ORDER BY last_interaction_at DESC,id LIMIT 50 OFFSET p_offset) c),'[]'),'limit',50,'offset',p_offset,'source','Tokko current client assignments; Ready/Busy is separate from tomorrow attendance') INTO result;
 RETURN result;
END $$;

-- Route the older Add to My Clients endpoint through the same Ready/accept
-- checks, rather than retaining a second way to take a reserved client.
ALTER FUNCTION veo_action(uuid,text,jsonb) RENAME TO veo_action_before_intake;
-- A service handover must not prevent the original seller completing an
-- existing Closed Deal. This exception requires its exact attributed record;
-- new sales still belong to the current accepted client owner.
DO $migration$ DECLARE fn record;definition text;changed integer:=0;old_guard text:=$old$IF FOUND AND(assigned IS NULL OR assigned IS DISTINCT FROM (p_data->>'seller_id')::uuid) THEN$old$;BEGIN
 FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'veo_action%' AND strpos(prosrc,old_guard)>0 LOOP
  definition:=replace(pg_get_functiondef(fn.signature),old_guard,$new$IF FOUND AND(assigned IS NULL OR assigned IS DISTINCT FROM (p_data->>'seller_id')::uuid) AND NOT(assigned IS NOT NULL AND EXISTS(SELECT 1 FROM veo_closed_deals d WHERE d.id=nullif(p_data->>'closed_deal_id','')::uuid AND d.contact_id=(p_data->>'contact_id')::uuid AND d.page_id=pg AND d.seller_id=(p_data->>'seller_id')::uuid AND d.order_id IS NULL AND d.voided_at IS NULL)) THEN$new$);
  EXECUTE definition;changed:=changed+1;
 END LOOP;
 IF changed<>1 THEN RAISE EXCEPTION 'Expected one attributed order ownership guard';END IF;
END $migration$;
CREATE FUNCTION veo_action(p_actor uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;responsible uuid;BEGIN
 IF p_action='client_assignment' THEN RETURN veo_intake_action(p_actor,CASE WHEN coalesce((p_data->>'user_id')::uuid,p_actor)=p_actor THEN 'accept' ELSE 'offer' END,p_data||jsonb_build_object('request_id',coalesce(nullif(p_data->>'request_id','')::uuid,gen_random_uuid())));END IF;
 result:=veo_action_before_intake(p_actor,p_action,p_data);
 IF p_action IN('order','import_business_order') THEN
  SELECT cc.user_id INTO responsible FROM veo_client_claims cc WHERE cc.contact_id=(result->>'contact_id')::uuid AND cc.user_id IS NOT NULL AND cc.user_id IS DISTINCT FROM (result->>'seller_id')::uuid AND veo_can_page(cc.user_id,(result->>'page_id')::uuid);
  IF responsible IS NOT NULL THEN INSERT INTO veo_order_work(order_id,assignee_id,updated_by) VALUES((result->>'id')::uuid,responsible,p_actor) ON CONFLICT(order_id) DO NOTHING;END IF;
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION veo_intake_recipient(uuid,uuid,uuid),veo_intake_can_offer(uuid,uuid,uuid),veo_intake_action(uuid,text,jsonb),veo_intake_page(uuid,text,uuid,text,integer),veo_action(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_intake_recipient(uuid,uuid,uuid),veo_intake_can_offer(uuid,uuid,uuid),veo_intake_action(uuid,text,jsonb),veo_intake_page(uuid,text,uuid,text,integer),veo_action(uuid,text,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
