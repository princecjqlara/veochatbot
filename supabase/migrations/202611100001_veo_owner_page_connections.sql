BEGIN;

-- One short-lived, encrypted Facebook grant per Owner. App sign-in is unchanged.
CREATE TABLE public.veo_page_authorizations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id uuid NOT NULL UNIQUE REFERENCES public.veo_accounts(user_id) ON DELETE CASCADE,
 tenant_id uuid NOT NULL REFERENCES public.veo_tenants(id),
 state_hash text NOT NULL CHECK(length(state_hash)=64),
 token_ciphertext text,
 state_used_at timestamptz,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.veo_page_authorizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.veo_page_authorizations FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.veo_page_authorizations TO service_role;

CREATE FUNCTION public.veo_claim_page_authorization(p_actor uuid,p_id uuid,p_state_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE veo_page_authorizations g SET state_used_at=clock_timestamp()
 WHERE g.id=p_id AND g.actor_id=p_actor AND g.state_hash=p_state_hash
 AND g.state_used_at IS NULL AND g.expires_at>clock_timestamp()
 AND EXISTS(SELECT 1 FROM veo_accounts a JOIN veo_tenants t ON t.id=a.tenant_id
 JOIN users u ON u.id=a.user_id WHERE a.user_id=p_actor AND a.active AND u.is_active
 AND a.role='owner' AND t.owner_id=p_actor AND t.launch_at IS NOT NULL AND a.tenant_id=g.tenant_id);
 RETURN FOUND;
END $$;

-- Reconnect by Facebook ID, retaining every dependent row and all staff grants.
CREATE FUNCTION public.veo_connect_page(p_actor uuid,p_facebook_id text,p_name text,p_token text,p_app text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a veo_accounts;existing pages;saved_id uuid;created boolean;BEGIN
 SELECT a1.* INTO a FROM veo_accounts a1 JOIN veo_tenants t ON t.id=a1.tenant_id
 JOIN users u ON u.id=a1.user_id WHERE a1.user_id=p_actor AND a1.active AND u.is_active
 AND a1.role='owner' AND t.owner_id=p_actor AND t.launch_at IS NOT NULL FOR UPDATE OF a1;
 IF a.user_id IS NULL THEN RAISE EXCEPTION 'Owner access required' USING ERRCODE='42501';END IF;
 IF p_facebook_id IS NULL OR p_facebook_id!~'^[0-9]{1,100}$' OR coalesce(length(btrim(p_name)),0)=0
 OR length(p_name)>500 OR coalesce(length(btrim(p_token)),0)=0 OR length(p_token)>8192 THEN RAISE EXCEPTION 'Invalid Page connection';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('veo-page:'||p_facebook_id,0));
 SELECT * INTO existing FROM pages WHERE fb_page_id=p_facebook_id FOR UPDATE;
 IF existing.id IS NOT NULL AND existing.veo_tenant_id IS DISTINCT FROM a.tenant_id
 AND(existing.veo_tenant_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM user_pages WHERE user_id=p_actor AND user_pages.page_id=existing.id)) THEN
  RAISE EXCEPTION 'This Page belongs to another workspace or owner' USING ERRCODE='42501';
 END IF;
 created:=existing.id IS NULL;
 IF created THEN
  INSERT INTO pages(fb_page_id,name,access_token,veo_tenant_id,veo_enabled)
  VALUES(p_facebook_id,btrim(p_name),p_token,a.tenant_id,true) RETURNING id INTO saved_id;
 ELSE
  saved_id:=existing.id;
  UPDATE pages SET name=btrim(p_name),access_token=p_token,veo_tenant_id=a.tenant_id,veo_enabled=true,updated_at=clock_timestamp() WHERE id=saved_id;
 END IF;
 INSERT INTO user_pages(user_id,page_id) VALUES(p_actor,saved_id) ON CONFLICT(user_id,page_id) DO NOTHING;
 IF p_app IS NOT NULL AND NOT register_automation_page_owner(saved_id,p_app) THEN
  RAISE EXCEPTION 'Page automation ownership could not be confirmed';
 END IF;
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value)
 VALUES(a.tenant_id,p_actor,CASE WHEN created THEN 'page_connect' ELSE 'page_reconnect' END,saved_id,
 CASE WHEN created THEN NULL ELSE jsonb_build_object('name',existing.name,'enabled',existing.veo_enabled) END,
 jsonb_build_object('facebook_page_id',p_facebook_id,'name',btrim(p_name),'enabled',true,'automation_confirmed',p_app IS NOT NULL));
 RETURN jsonb_build_object('id',saved_id,'created',created);
END $$;

REVOKE ALL ON FUNCTION public.veo_claim_page_authorization(uuid,uuid,text),public.veo_connect_page(uuid,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.veo_claim_page_authorization(uuid,uuid,text),public.veo_connect_page(uuid,text,text,text,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
