BEGIN;
CREATE FUNCTION public.veo_recover_account_login(p_actor uuid,p_user uuid,p_email text,p_password_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor veo_accounts;target veo_accounts;result jsonb;
BEGIN
 SELECT a.* INTO actor FROM veo_accounts a JOIN users u ON u.id=a.user_id JOIN veo_tenants t ON t.id=a.tenant_id
 WHERE a.user_id=p_actor AND a.role='owner' AND a.active AND u.is_active AND t.owner_id=p_actor;
 SELECT * INTO target FROM veo_accounts WHERE user_id=p_user AND active AND departed_at IS NULL FOR UPDATE;
 IF actor.user_id IS NULL OR target.user_id IS NULL OR target.tenant_id<>actor.tenant_id THEN RAISE EXCEPTION 'Owner account access required' USING ERRCODE='42501';END IF;
 p_email:=lower(btrim(p_email));
 IF p_email IS NULL OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' OR length(p_email)>254
 OR p_password_hash IS NULL OR length(p_password_hash)<>71 OR p_password_hash NOT LIKE 'veo-sha256:$2%' THEN RAISE EXCEPTION 'Valid email and hashed password required';END IF;
 IF EXISTS(SELECT 1 FROM users WHERE lower(email)=p_email AND id<>p_user) THEN RAISE EXCEPTION 'Email already belongs to another account' USING ERRCODE='23505';END IF;
 UPDATE users SET email=p_email,password_hash=p_password_hash,is_active=true WHERE id=p_user;
 result:=jsonb_build_object('id',p_user,'email',p_email,'role',target.role,'active',true);
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value,reason)
 VALUES(actor.tenant_id,p_actor,'account_login_recovery',p_user,result,'Owner configured recovered account email and password');
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.veo_recover_account_login(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.veo_recover_account_login(uuid,uuid,text,text) TO service_role;
INSERT INTO app_private.schema_migrations(version,description) VALUES('202611090004','Owner configures restored account login without changing identity or permissions') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
