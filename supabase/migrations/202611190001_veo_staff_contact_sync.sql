BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='10s';

-- Keep the existing identity-only insert, trigger suppression and missing-name
-- reconciliation. Widen only the live actor/Page permission check.
DO $migration$
DECLARE definition text;old_guard text;new_guard text;
BEGIN
 definition:=pg_get_functiondef('public.veo_seed_contact_identities_before_names(uuid,uuid,jsonb)'::regprocedure);
 old_guard:=$old$IF NOT EXISTS(SELECT 1 FROM veo_accounts a JOIN users u ON u.id=a.user_id WHERE a.user_id=p_actor AND a.active AND u.is_active AND a.role='owner')
 OR NOT veo_can_page(p_actor,p_page) THEN RAISE EXCEPTION 'Owner Page access required' USING ERRCODE='42501';END IF;$old$;
 new_guard:=$new$IF veo_member_suspension(p_actor) IS NOT NULL OR NOT EXISTS(
 SELECT 1 FROM veo_accounts a JOIN users u ON u.id=a.user_id AND u.is_active
 JOIN pages p ON p.id=p_page AND p.veo_tenant_id=a.tenant_id AND p.veo_enabled
 JOIN veo_tenants t ON t.id=a.tenant_id AND t.launch_at IS NOT NULL
 WHERE a.user_id=p_actor AND a.active AND a.departed_at IS NULL AND a.role IN('owner','team_leader','manager','member'))
 OR NOT veo_can_page(p_actor,p_page) THEN RAISE EXCEPTION 'Active workspace Page access required' USING ERRCODE='42501';END IF;$new$;
 IF strpos(definition,old_guard)=0 THEN RAISE EXCEPTION 'Expected identity sync authorization is missing';END IF;
 EXECUTE replace(definition,old_guard,new_guard);
END $migration$;

REVOKE ALL ON FUNCTION public.veo_seed_contact_identities(uuid,uuid,jsonb),public.veo_seed_contact_identities_before_names(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.veo_seed_contact_identities(uuid,uuid,jsonb),public.veo_seed_contact_identities_before_names(uuid,uuid,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
