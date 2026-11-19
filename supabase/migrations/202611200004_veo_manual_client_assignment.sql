BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';

CREATE FUNCTION veo_client_assignment_context(p_actor uuid,p_contact uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit=off SET statement_timeout='5s' AS $$
DECLARE a veo_accounts;c contacts;claim veo_client_claims;targets jsonb;BEGIN
 SELECT x.* INTO a FROM veo_accounts x JOIN users u ON u.id=x.user_id AND u.is_active WHERE x.user_id=p_actor AND x.active AND x.departed_at IS NULL;
 IF a.user_id IS NULL OR a.role NOT IN('owner','team_leader','manager') OR veo_member_suspension(p_actor) IS NOT NULL THEN
  RAISE EXCEPTION 'Owner, Manager or Team Leader access required' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM contacts WHERE id=p_contact;
 IF c.id IS NULL OR NOT veo_can_page(p_actor,c.page_id) OR NOT EXISTS(SELECT 1 FROM pages p JOIN veo_tenants t ON t.id=p.veo_tenant_id WHERE p.id=c.page_id AND t.id=a.tenant_id AND p.veo_enabled AND t.launch_at IS NOT NULL) THEN
  RAISE EXCEPTION 'Client is outside your assigned Pages' USING ERRCODE='42501';END IF;
 SELECT * INTO claim FROM veo_client_claims WHERE contact_id=c.id;
 IF claim.contact_id IS NOT NULL AND(claim.tenant_id<>a.tenant_id OR claim.page_id<>c.page_id) THEN RAISE EXCEPTION 'Client assignment needs Owner review' USING ERRCODE='42501';END IF;
 IF a.role<>'owner' AND coalesce(claim.user_id,claim.previous_user_id) IS NOT NULL
 AND coalesce(claim.user_id,claim.previous_user_id) NOT IN(SELECT veo_descendants(p_actor)) THEN
  RAISE EXCEPTION 'This client belongs to another branch. Ask a shared Team Leader or the Owner to reassign it.' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',w.user_id,'name',u.name,'role',w.role) ORDER BY u.name,w.user_id),'[]') INTO targets
 FROM veo_accounts w JOIN users u ON u.id=w.user_id AND u.is_active
 WHERE w.tenant_id=a.tenant_id AND w.active AND w.departed_at IS NULL AND w.role IN('member','manager')
 AND w.user_id IN(SELECT veo_descendants(p_actor)) AND veo_can_page(w.user_id,c.page_id) AND veo_member_suspension(w.user_id) IS NULL
 AND EXISTS(SELECT 1 FROM veo_teams team WHERE team.tenant_id=a.tenant_id AND team.manager_id=CASE WHEN w.role='manager' THEN w.user_id ELSE w.parent_id END);
 RETURN jsonb_build_object('contact',jsonb_build_object('id',c.id,'name',c.name,'page_id',c.page_id,'page_name',(SELECT name FROM pages WHERE id=c.page_id)),
  'owner',CASE WHEN claim.user_id IS NULL THEN NULL ELSE jsonb_build_object('id',claim.user_id,'name',(SELECT name FROM users WHERE id=claim.user_id)) END,
  'targets',targets,'released',claim.released_at IS NOT NULL,'claimed_at',claim.claimed_at);
END $$;

CREATE FUNCTION veo_manual_client_assignment(p_actor uuid,p_contact uuid,p_seller uuid,p_expected_owner uuid,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off SET statement_timeout='5s' SET lock_timeout='1s' AS $$
DECLARE context jsonb;a veo_accounts;c contacts;claim veo_client_claims;result jsonb;at timestamptz:=clock_timestamp();BEGIN
 -- Fence against both another assignment and a simultaneous worker departure.
 PERFORM 1 FROM veo_accounts WHERE user_id IN(p_actor,p_seller) ORDER BY user_id FOR UPDATE;
 SELECT * INTO c FROM contacts WHERE id=p_contact FOR UPDATE;
 context:=veo_client_assignment_context(p_actor,p_contact);
 IF p_seller IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(context->'targets') target WHERE target->>'id'=p_seller::text) THEN
  RAISE EXCEPTION 'Choose an active selling worker in your branch with access to this Page' USING ERRCODE='42501';END IF;
 IF length(btrim(coalesce(p_reason,''))) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'Enter an assignment reason of 3 to 500 characters' USING ERRCODE='23514';END IF;
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor;
 SELECT * INTO claim FROM veo_client_claims WHERE contact_id=c.id FOR UPDATE;
 IF claim.user_id=p_seller THEN RETURN context||jsonb_build_object('saved',true,'unchanged',true);END IF;
 IF claim.user_id IS DISTINCT FROM p_expected_owner THEN RAISE EXCEPTION 'The client assignment changed. Refresh it before saving again.' USING ERRCODE='PT409';END IF;
 INSERT INTO veo_client_claims(contact_id,tenant_id,page_id,user_id,previous_user_id,claimed_at)
 VALUES(c.id,a.tenant_id,c.page_id,p_seller,coalesce(claim.user_id,claim.previous_user_id),at)
 ON CONFLICT(contact_id) DO UPDATE SET user_id=EXCLUDED.user_id,previous_user_id=EXCLUDED.previous_user_id,claimed_at=at,released_at=NULL,release_reason=NULL
 RETURNING to_jsonb(veo_client_claims.*) INTO result;
 UPDATE veo_client_offers SET status='cancelled',ended_at=at WHERE status='pending' AND(contact_id=c.id OR offered_to=p_seller);
 UPDATE veo_intake_dispatch SET status='accepted',last_error=NULL WHERE contact_id=c.id AND status IN('waiting','offered');
 UPDATE veo_intake_readiness SET status='busy',updated_at=at WHERE user_id=p_seller;
 -- Accepting a manual assignment pauses automation for this client's human work.
 PERFORM set_contact_bot_permission(c.page_id,c.id,p_actor,false);
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value,reason)
 VALUES(a.tenant_id,p_actor,'client_assignment',c.id,to_jsonb(claim),result||jsonb_build_object('method','supervisor_manual','assigned_by',p_actor),btrim(p_reason));
 RETURN veo_client_assignment_context(p_actor,p_contact)||jsonb_build_object('saved',true,'unchanged',false);
END $$;

REVOKE ALL ON FUNCTION veo_client_assignment_context(uuid,uuid),veo_manual_client_assignment(uuid,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_client_assignment_context(uuid,uuid),veo_manual_client_assignment(uuid,uuid,uuid,uuid,text) TO service_role;
INSERT INTO app_private.schema_migrations(version,description)
VALUES('202611200004','Audited immediate supervisor client assignment with Page, branch, suspension and stale-owner checks; preserve financial attribution') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
