BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE FUNCTION veo_capture_inbound_contact(p_page uuid,p_at timestamptz,p_payload jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m jsonb;sender text;client uuid;BEGIN
 m:=coalesce(p_payload#>'{entry,0,messaging,0}',p_payload#>'{entry,0,standby,0}');sender:=m#>>'{sender,id}';
 IF sender IS NULL OR sender !~ '^[0-9]{1,40}$' OR nullif(m#>>'{message,mid}','') IS NULL OR m#>>'{message,is_echo}'='true' OR m#>>'{message,is_deleted}'='true' OR p_at>clock_timestamp()+interval '1 minute' THEN RETURN NULL;END IF;
 IF NOT EXISTS(SELECT 1 FROM pages p JOIN veo_tenants t ON t.id=p.veo_tenant_id WHERE p.id=p_page AND p.veo_enabled AND t.launch_at IS NOT NULL AND p_at>=t.launch_at AND p.fb_page_id=p_payload#>>'{entry,0,id}' AND p.fb_page_id=m#>>'{recipient,id}' AND sender<>p.fb_page_id) THEN RETURN NULL;END IF;
 INSERT INTO contacts(page_id,psid,first_interaction_at,last_interaction_at,last_inbound_at) VALUES(p_page,sender,p_at,p_at,p_at)
 ON CONFLICT(page_id,psid) DO UPDATE SET last_interaction_at=greatest(contacts.last_interaction_at,EXCLUDED.last_interaction_at),last_inbound_at=greatest(contacts.last_inbound_at,EXCLUDED.last_inbound_at)
 WHERE contacts.last_inbound_at IS NULL OR contacts.last_inbound_at<EXCLUDED.last_inbound_at RETURNING id INTO client;
 IF client IS NULL THEN SELECT id INTO client FROM contacts WHERE page_id=p_page AND psid=sender;END IF;
 RETURN client;
END $$;

DO $$ DECLARE definition text;needle text:=' INSERT INTO veo_event_inbox(event_key,page_id,occurred_at,payload)';BEGIN
 definition:=pg_get_functiondef('veo_ingest_event(text,text,timestamptz,jsonb)'::regprocedure);
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Webhook ingestion implementation changed';END IF;
 EXECUTE replace(definition,needle,' PERFORM veo_capture_inbound_contact(pg,p_at,p_payload);'||E'\n'||needle);
END $$;

CREATE FUNCTION veo_recover_queued_contact_identities(p_limit integer DEFAULT 1000) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record;n integer:=0;BEGIN
 FOR r IN SELECT DISTINCT ON(i.page_id,coalesce(i.payload#>>'{entry,0,messaging,0,sender,id}',i.payload#>>'{entry,0,standby,0,sender,id}')) i.page_id,i.occurred_at,i.payload
 FROM veo_event_inbox i LEFT JOIN contacts c ON c.page_id=i.page_id AND c.psid=coalesce(i.payload#>>'{entry,0,messaging,0,sender,id}',i.payload#>>'{entry,0,standby,0,sender,id}')
 WHERE i.status='queued' AND coalesce(i.payload#>>'{entry,0,messaging,0,message,is_echo}',i.payload#>>'{entry,0,standby,0,message,is_echo}','false')<>'true'
 AND(c.id IS NULL OR c.last_inbound_at IS NULL OR c.last_inbound_at<i.occurred_at)
 ORDER BY i.page_id,coalesce(i.payload#>>'{entry,0,messaging,0,sender,id}',i.payload#>>'{entry,0,standby,0,sender,id}'),i.occurred_at
 LIMIT least(greatest(p_limit,1),1000) LOOP
  IF veo_capture_inbound_contact(r.page_id,r.occurred_at,r.payload) IS NOT NULL THEN n:=n+1;END IF;
 END LOOP;
 RETURN n;
END $$;

ALTER TABLE veo_background_job_leases DROP CONSTRAINT veo_background_job_leases_job_check;
ALTER TABLE veo_background_job_leases ADD CONSTRAINT veo_background_job_leases_job_check CHECK(job IN('workspace','contact-profiles','workspace-events'));
DO $$ DECLARE definition text;needle text:='p_job NOT IN(''workspace'',''contact-profiles'')';BEGIN
 definition:=pg_get_functiondef('veo_claim_background_job(text,uuid)'::regprocedure);
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Background coordination implementation changed';END IF;
 EXECUTE replace(definition,needle,'p_job NOT IN(''workspace'',''contact-profiles'',''workspace-events'')');
END $$;

CREATE TABLE veo_contact_identity_sync(page_id uuid PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,cursor text,last_checked_at timestamptz,next_check_at timestamptz NOT NULL DEFAULT now(),lease_owner uuid,last_error text,inserted integer NOT NULL DEFAULT 0,updated_names integer NOT NULL DEFAULT 0);
ALTER TABLE veo_contact_identity_sync ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON veo_contact_identity_sync FROM PUBLIC,anon,authenticated;
GRANT ALL ON veo_contact_identity_sync TO service_role;

CREATE FUNCTION veo_claim_contact_identity_pages(p_limit integer DEFAULT 3) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record;owner uuid;items jsonb:='[]';BEGIN
 FOR r IN SELECT p.id,p.fb_page_id,p.access_token,t.owner_id,s.cursor FROM pages p JOIN veo_tenants t ON t.id=p.veo_tenant_id AND t.launch_at IS NOT NULL
 JOIN veo_accounts a ON a.user_id=t.owner_id AND a.active AND a.role='owner' JOIN users u ON u.id=a.user_id AND u.is_active
 LEFT JOIN veo_contact_identity_sync s ON s.page_id=p.id
 WHERE p.veo_enabled AND coalesce(p.access_token,'')<>'' AND veo_can_page(t.owner_id,p.id) AND(s.page_id IS NULL OR s.next_check_at<=now())
 AND NOT EXISTS(SELECT 1 FROM page_sync_leases lease WHERE lease.page_id=p.id AND lease.expires_at>now())
 ORDER BY s.last_checked_at NULLS FIRST,p.id LIMIT least(greatest(p_limit,1),5) FOR UPDATE OF p SKIP LOCKED LOOP
  owner:=gen_random_uuid();
  IF acquire_page_sync_lease(r.id,owner::text,60) THEN
   INSERT INTO veo_contact_identity_sync(page_id,lease_owner,next_check_at) VALUES(r.id,owner,now()+interval '1 minute') ON CONFLICT(page_id) DO UPDATE SET lease_owner=owner,next_check_at=now()+interval '1 minute';
   items:=items||jsonb_build_array(jsonb_build_object('page_id',r.id,'fb_page_id',r.fb_page_id,'access_token',r.access_token,'owner_id',r.owner_id,'cursor',r.cursor,'lease_owner',owner));
  END IF;
 END LOOP;
 RETURN items;
END $$;

CREATE FUNCTION veo_finish_contact_identity_page(p_page uuid,p_lease uuid,p_cursor text,p_inserted integer,p_updated integer,p_error text DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE changed boolean;BEGIN
 UPDATE veo_contact_identity_sync SET cursor=CASE WHEN p_error IS NULL THEN p_cursor ELSE cursor END,last_checked_at=clock_timestamp(),next_check_at=clock_timestamp()+CASE WHEN p_error IS NULL THEN interval '1 minute' ELSE interval '5 minutes' END,
 inserted=inserted+greatest(coalesce(p_inserted,0),0),updated_names=updated_names+greatest(coalesce(p_updated,0),0),last_error=left(p_error,300),lease_owner=NULL WHERE page_id=p_page AND lease_owner=p_lease;
 changed:=FOUND;IF changed THEN PERFORM release_page_sync_lease(p_page,p_lease::text);END IF;RETURN changed;
END $$;

ALTER FUNCTION veo_seed_contact_identities(uuid,uuid,jsonb) RENAME TO veo_seed_contact_identities_before_names;
CREATE FUNCTION veo_seed_contact_identities(p_actor uuid,p_page uuid,p_contacts jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;updated integer;BEGIN
 result:=veo_seed_contact_identities_before_names(p_actor,p_page,p_contacts);
 UPDATE contacts c SET name=names.name FROM(SELECT DISTINCT ON(x->>'psid') x->>'psid' psid,nullif(btrim(x->>'name'),'') name FROM jsonb_array_elements(p_contacts) x WHERE nullif(btrim(x->>'name'),'') IS NOT NULL) names
 WHERE c.page_id=p_page AND c.psid=names.psid AND nullif(btrim(c.name),'') IS NULL;
 GET DIAGNOSTICS updated=ROW_COUNT;
 RETURN result||jsonb_build_object('updated_names',updated);
END $$;

CREATE FUNCTION veo_collection_status(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE scope jsonb;result jsonb;BEGIN
 scope:=veo_scope(p_actor);IF scope->>'launch_at' IS NULL THEN RAISE EXCEPTION 'Workspace access required' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('page_id',p.id,'last_event_at',e.last_event_at,'last_processed_at',e.last_processed_at,'pending',coalesce(e.pending,0),'errors',coalesce(e.errors,0),'oldest_pending_at',e.oldest_pending_at,'identity_sync_at',s.last_checked_at,'identity_sync_error',s.last_error,'coverage','Live Facebook events plus automatic, resumable identity reconciliation. Historical messages and sales are not imported.')),'[]') INTO result
 FROM pages p LEFT JOIN veo_contact_identity_sync s ON s.page_id=p.id LEFT JOIN LATERAL(SELECT max(received_at) last_event_at,max(received_at) FILTER(WHERE status='done') last_processed_at,count(*) FILTER(WHERE status<>'done') pending,count(*) FILTER(WHERE status<>'done' AND last_error IS NOT NULL) errors,min(received_at) FILTER(WHERE status<>'done') oldest_pending_at FROM veo_event_inbox WHERE page_id=p.id)e ON true
 WHERE p.id IN(SELECT value::uuid FROM jsonb_array_elements_text(scope->'page_ids'));
 RETURN result;
END $$;

DO $$ DECLARE fn record;BEGIN
 FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_capture_inbound_contact','veo_recover_queued_contact_identities','veo_claim_contact_identity_pages','veo_finish_contact_identity_page','veo_seed_contact_identities','veo_seed_contact_identities_before_names','veo_collection_status') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);
 END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
