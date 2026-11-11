BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

-- Roster recovery happened after the original team backfill. Keep each
-- existing team and create only the missing supervisor's direct-member team.
INSERT INTO public.veo_teams(tenant_id,manager_id,name)
SELECT a.tenant_id,a.user_id,u.name||CASE WHEN a.role='team_leader' THEN ' (direct members)' ELSE ' team' END
FROM public.veo_accounts a JOIN public.users u ON u.id=a.user_id
WHERE a.active AND a.departed_at IS NULL AND a.role IN('team_leader','manager')
ON CONFLICT(manager_id) DO NOTHING;

CREATE FUNCTION public.veo_account_access(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor veo_accounts;result jsonb;
BEGIN
 SELECT a.* INTO actor FROM veo_accounts a JOIN users u ON u.id=a.user_id AND u.is_active
 WHERE a.user_id=p_actor AND a.active AND a.role='owner';
 IF actor.user_id IS NULL THEN RAISE EXCEPTION 'Owner access required' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.user_id,'name',u.name,'email',u.email,'role',a.role,'active',a.active,
  'login_enabled',u.is_active,'status',CASE
   WHEN NOT a.active OR a.departed_at IS NOT NULL THEN 'departed'
   WHEN u.email IS NULL OR btrim(u.email) !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' OR length(u.email)>254 THEN 'email_required'
   WHEN u.password_hash IS NULL OR length(u.password_hash)<>71 OR u.password_hash NOT LIKE 'veo-sha256:$2%' THEN 'password_required'
   WHEN u.is_active IS NOT TRUE THEN 'disabled'
   WHEN l.attempts>10 AND l.window_at>now()-interval '15 minutes' THEN 'temporarily_locked'
   ELSE 'ready' END,
  'retry_at',CASE WHEN l.attempts>10 AND l.window_at>now()-interval '15 minutes' THEN l.window_at+interval '15 minutes' END)
  ORDER BY u.name,a.user_id),'[]') INTO result
 FROM veo_accounts a JOIN users u ON u.id=a.user_id
 LEFT JOIN veo_login_limits l ON l.key=encode(sha256(convert_to(lower(btrim(u.email)),'UTF8')),'hex')
 WHERE a.tenant_id=actor.tenant_id;
 RETURN jsonb_build_object('accounts',result);
END $$;

ALTER FUNCTION public.veo_recover_account_login(uuid,uuid,text,text) RENAME TO veo_recover_account_login_before_access;
CREATE FUNCTION public.veo_recover_account_login(p_actor uuid,p_user uuid,p_email text,p_password_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
 result:=veo_recover_account_login_before_access(p_actor,p_user,p_email,p_password_hash);
 INSERT INTO veo_teams(tenant_id,manager_id,name)
 SELECT a.tenant_id,a.user_id,u.name||CASE WHEN a.role='team_leader' THEN ' (direct members)' ELSE ' team' END
 FROM veo_accounts a JOIN users u ON u.id=a.user_id
 WHERE a.user_id=p_user AND a.active AND a.departed_at IS NULL AND a.role IN('team_leader','manager')
 ON CONFLICT(manager_id) DO NOTHING;
 DELETE FROM veo_login_limits WHERE key=encode(sha256(convert_to(result->>'email','UTF8')),'hex');
 RETURN result;
END $$;

CREATE FUNCTION public.veo_set_account_password(p_actor uuid,p_user uuid,p_password_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;email text;enabled boolean;
BEGIN
 IF p_password_hash IS NULL OR length(p_password_hash)<>71 OR p_password_hash NOT LIKE 'veo-sha256:$2%' THEN RAISE EXCEPTION 'Valid hashed password required';END IF;
 result:=veo_action(p_actor,'password',jsonb_build_object('user_id',p_user,'password_hash',p_password_hash));
 SELECT u.email,u.is_active INTO email,enabled FROM users u WHERE u.id=p_user;
 IF nullif(btrim(email),'') IS NULL OR enabled IS NOT TRUE THEN
  RAISE EXCEPTION 'Account sign-in setup is incomplete. Ask the Owner to save its email and password in Accounts.';
 END IF;
 DELETE FROM veo_login_limits WHERE key=encode(sha256(convert_to(lower(btrim(email)),'UTF8')),'hex');
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.veo_account_access(uuid),public.veo_recover_account_login(uuid,uuid,text,text),public.veo_set_account_password(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.veo_account_access(uuid),public.veo_recover_account_login(uuid,uuid,text,text),public.veo_set_account_password(uuid,uuid,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
