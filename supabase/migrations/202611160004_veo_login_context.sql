BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
-- Login needs an enabled identity, not every descendant and Page permission.
-- Credentials stay service-only and password comparison remains on the server.
CREATE FUNCTION public.veo_login_context(p_email text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET statement_timeout='5s' AS $$
DECLARE matches jsonb;
BEGIN
 p_email:=lower(btrim(p_email));
 IF p_email IS NULL OR length(p_email) NOT BETWEEN 3 AND 254 THEN RETURN NULL;END IF;
 IF NOT public.veo_login_attempt(encode(sha256(convert_to(p_email,'UTF8')),'hex')) THEN
  RETURN jsonb_build_object('limited',true);
 END IF;
 SELECT jsonb_agg(jsonb_build_object('id',u.id,'name',u.name,'email',u.email,'image',u.image,'password_hash',u.password_hash)) INTO matches
 FROM public.users u JOIN public.veo_accounts a ON a.user_id=u.id
 JOIN public.veo_tenants t ON t.id=a.tenant_id
 WHERE lower(btrim(u.email))=p_email AND u.is_active AND a.active AND a.departed_at IS NULL
 AND a.role IN('owner','team_leader','manager','member') AND t.launch_at IS NOT NULL;
 IF jsonb_array_length(matches)>1 THEN RAISE EXCEPTION 'Ambiguous account sign-in';END IF;
 RETURN matches->0;
END $$;
REVOKE ALL ON FUNCTION public.veo_login_context(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.veo_login_context(text) TO service_role;
INSERT INTO app_private.schema_migrations(version,description) VALUES('202611160004','Bounded service-only login context without full permission graph hydration') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
