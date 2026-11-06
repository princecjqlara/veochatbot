BEGIN;
ALTER TABLE veo_accounts ADD COLUMN telegram_username text CHECK(telegram_username ~ '^[a-z0-9_]{1,32}$');
ALTER TABLE veo_accounts ADD COLUMN telegram_profile_completed_at timestamptz;

CREATE OR REPLACE FUNCTION public.veo_scope(p_actor uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('user_id',a.user_id,'tenant_id',a.tenant_id,'role',a.role,'launch_at',t.launch_at,
 'telegram_username',a.telegram_username,'telegram_profile_completed_at',a.telegram_profile_completed_at,
 'page_ids',coalesce((SELECT jsonb_agg(p.id) FROM pages p WHERE veo_can_page(p_actor,p.id)),'[]'),
 'worker_ids',coalesce((SELECT jsonb_agg(d) FROM veo_descendants(p_actor) d),'[]'))
 FROM veo_accounts a JOIN veo_tenants t ON t.id=a.tenant_id WHERE a.user_id=p_actor AND a.active
$$;

CREATE FUNCTION public.veo_save_telegram_profile(p_actor uuid,p_username text,p_no_username boolean DEFAULT false) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE account veo_accounts; username text; previous jsonb; result jsonb;
 BEGIN
 SELECT a.* INTO account FROM veo_accounts a JOIN veo_tenants t ON t.id=a.tenant_id WHERE a.user_id=p_actor AND a.active AND t.launch_at IS NOT NULL FOR UPDATE OF a;
 IF NOT FOUND THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 username:=lower(regexp_replace(btrim(coalesce(p_username,'')),'^@',''));
 IF (p_no_username AND username<>'') OR (NOT p_no_username AND username !~ '^[a-z0-9_]{1,32}$') OR p_no_username IS NULL THEN RAISE EXCEPTION 'Enter your Telegram username using letters, numbers and underscores, or choose no username'; END IF;
 previous:=jsonb_build_object('telegram_username',account.telegram_username,'telegram_profile_completed_at',account.telegram_profile_completed_at);
 UPDATE veo_accounts SET telegram_username=CASE WHEN p_no_username THEN NULL ELSE username END,telegram_profile_completed_at=clock_timestamp()
 WHERE user_id=p_actor RETURNING jsonb_build_object('telegram_username',telegram_username,'telegram_profile_completed_at',telegram_profile_completed_at) INTO result;
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value)
 VALUES(account.tenant_id,p_actor,'telegram_profile',p_actor,previous,result);
 RETURN result;
 END $$;

CREATE FUNCTION public.veo_contacts_page(p_actor uuid,p_page uuid DEFAULT NULL,p_search text DEFAULT '',p_offset integer DEFAULT 0,p_limit integer DEFAULT 25) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE scope jsonb; result jsonb;
 BEGIN
 scope:=veo_scope(p_actor);
 IF scope IS NULL OR scope->>'launch_at' IS NULL OR(p_page IS NOT NULL AND NOT veo_can_page(p_actor,p_page)) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF p_offset<0 OR p_offset>10000000 OR p_limit<1 OR p_limit>100 OR length(p_search)>200 THEN RAISE EXCEPTION 'Invalid contact filters'; END IF;
 WITH eligible AS MATERIALIZED(
 SELECT c.id,c.page_id,c.name,c.psid,c.pipeline_stage,c.profile_pic,c.last_interaction_at,p.name AS page_name
 FROM contacts c JOIN pages p ON p.id=c.page_id LEFT JOIN veo_contact_details d ON d.contact_id=c.id
 WHERE c.page_id IN(SELECT value::uuid FROM jsonb_array_elements_text(scope->'page_ids')) AND(p_page IS NULL OR c.page_id=p_page)
 AND(p_search='' OR strpos(lower(concat_ws(' ',c.name,c.psid)),lower(p_search))>0 OR
 EXISTS(SELECT 1 FROM jsonb_each_text(coalesce(d.fields,'{}')) f WHERE strpos(lower(f.value),lower(p_search))>0))
 ), selected AS(SELECT * FROM eligible ORDER BY last_interaction_at DESC NULLS LAST,id OFFSET p_offset LIMIT p_limit)
 SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(to_jsonb(s.*) ORDER BY s.last_interaction_at DESC NULLS LAST,s.id) FROM selected s),'[]'),
 'total',(SELECT count(*) FROM eligible),'offset',p_offset,'limit',p_limit) INTO result;
 RETURN result;
 END $$;

-- Supervisor account directories display self-reported usernames without changing
-- the separately verified numeric Telegram delivery mappings.
DO $migration$
 DECLARE definition text; previous text;
 BEGIN
 definition:=pg_get_functiondef('public.veo_dashboard(uuid,date)'::regprocedure);
 previous:=$old$'role',a.role,'parent_id',a.parent_id,$old$;
 IF strpos(definition,previous)=0 THEN RAISE EXCEPTION 'Workspace directory migration source mismatch'; END IF;
 definition:=replace(definition,previous,$new$'role',a.role,'parent_id',a.parent_id,'telegram_username',a.telegram_username,'telegram_profile_completed_at',a.telegram_profile_completed_at,$new$);
 EXECUTE definition;
 END $migration$;
REVOKE ALL ON FUNCTION veo_scope(uuid),veo_save_telegram_profile(uuid,text,boolean),veo_contacts_page(uuid,uuid,text,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_scope(uuid),veo_save_telegram_profile(uuid,text,boolean),veo_contacts_page(uuid,uuid,text,integer,integer) TO service_role;
COMMIT;
