BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION public.veo_change_member_supervisor(p_actor uuid,p_user uuid,p_parent uuid,p_expected_parent uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor veo_accounts;member veo_accounts;supervisor veo_accounts;result jsonb;
BEGIN
 SELECT a.* INTO actor FROM veo_accounts a JOIN users u ON u.id=a.user_id AND u.is_active
 WHERE a.user_id=p_actor AND a.active AND a.role IN('owner','team_leader');
 IF actor.user_id IS NULL THEN RAISE EXCEPTION 'Owner or Team Leader access required' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('veo-member-supervision:'||actor.tenant_id::text,0));
 SELECT * INTO member FROM veo_accounts WHERE user_id=p_user AND tenant_id=actor.tenant_id AND active AND departed_at IS NULL AND role='member' FOR UPDATE;
 SELECT * INTO supervisor FROM veo_accounts WHERE user_id=p_parent AND tenant_id=actor.tenant_id AND active AND departed_at IS NULL AND role IN('team_leader','manager') FOR SHARE;
 IF member.user_id IS NULL OR supervisor.user_id IS NULL OR p_user NOT IN(SELECT veo_descendants(p_actor)) OR p_parent NOT IN(SELECT veo_descendants(p_actor)) THEN
  RAISE EXCEPTION 'Choose an active member and supervisor within your branch' USING ERRCODE='42501';
 END IF;
 IF member.parent_id IS DISTINCT FROM p_expected_parent THEN RAISE EXCEPTION 'Supervisor changed. Refresh Accounts before saving again' USING ERRCODE='40001';END IF;
 IF EXISTS(SELECT 1 FROM user_pages g JOIN pages p ON p.id=g.page_id WHERE g.user_id=p_user AND p.veo_enabled AND p.veo_tenant_id=actor.tenant_id AND NOT veo_can_page(p_parent,p.id)) THEN
  RAISE EXCEPTION 'The new supervisor needs access to all of this member''s assigned Pages first' USING ERRCODE='42501';
 END IF;
 result:=jsonb_build_object('id',p_user,'parent_id',p_parent,'credentials_unchanged',true,'page_assignments_unchanged',true);
 IF member.parent_id=p_parent THEN RETURN result;END IF;
 UPDATE veo_accounts SET parent_id=p_parent WHERE user_id=p_user;
 UPDATE veo_telegram_sync_state SET next_sync_at=least(next_sync_at,clock_timestamp()) WHERE tenant_id=actor.tenant_id;
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value,reason)
 VALUES(actor.tenant_id,p_actor,'member_supervisor_changed',p_user,jsonb_build_object('parent_id',member.parent_id),result,'Existing member moved without changing login, Page assignments or recorded history');
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.veo_change_member_supervisor(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.veo_change_member_supervisor(uuid,uuid,uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
