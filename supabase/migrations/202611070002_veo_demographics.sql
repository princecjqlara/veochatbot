BEGIN;
CREATE TABLE veo_contact_demographics(
 contact_id uuid PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,page_id uuid NOT NULL REFERENCES pages(id),
 fields jsonb NOT NULL DEFAULT '[]',status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','processing','ready','error')),
 requested_version integer NOT NULL DEFAULT 1,working_version integer,analyzed_version integer NOT NULL DEFAULT 0,
 attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz,claim_token uuid,
 analyzed_at timestamptz,source_hash text,last_error text,coverage text NOT NULL DEFAULT 'Saved customer excerpts and new launch-period events; full historical coverage is not implied'
);
CREATE INDEX ON veo_contact_demographics(next_attempt_at) WHERE status IN('queued','error');
ALTER TABLE veo_contact_demographics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON veo_contact_demographics FROM PUBLIC,anon,authenticated;
GRANT ALL ON veo_contact_demographics TO service_role;
CREATE FUNCTION veo_demographic_values(p_contact uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT coalesce(jsonb_object_agg(f->>'field',f->>'value'),'{}') FROM veo_contact_demographics d CROSS JOIN LATERAL jsonb_array_elements(d.fields) f WHERE d.contact_id=p_contact
$$;
CREATE FUNCTION veo_demographic_enqueue(p_contact uuid,p_manual boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pg uuid;
BEGIN
 SELECT c.page_id INTO pg FROM contacts c JOIN pages p ON p.id=c.page_id AND p.veo_enabled JOIN veo_tenants t ON t.id=p.veo_tenant_id
 WHERE c.id=p_contact AND t.launch_at IS NOT NULL AND veo_can_page(t.owner_id,p.id);
 IF pg IS NULL THEN RETURN false;END IF;
 INSERT INTO veo_contact_demographics(contact_id,page_id,next_attempt_at) VALUES(p_contact,pg,now()+CASE WHEN p_manual THEN interval '-1 hour' ELSE interval '45 seconds' END)
 ON CONFLICT(contact_id) DO UPDATE SET requested_version=veo_contact_demographics.requested_version+1,
 status=CASE WHEN veo_contact_demographics.status='processing' AND veo_contact_demographics.lease_until>now() THEN 'processing' ELSE 'queued' END,
 next_attempt_at=CASE WHEN p_manual THEN now()-interval '1 hour' ELSE greatest(now()+interval '45 seconds',coalesce(veo_contact_demographics.analyzed_at,'-infinity')+interval '15 minutes') END;
 RETURN true;
END $$;
CREATE FUNCTION veo_demographic_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m jsonb;client uuid;
BEGIN
 m:=coalesce(NEW.payload#>'{entry,0,messaging,0}',NEW.payload#>'{entry,0,standby,0}');
 IF m#>>'{message,text}' IS NULL OR m#>>'{message,is_echo}'='true' OR m#>>'{message,is_deleted}'='true' THEN RETURN NEW;END IF;
 SELECT c.id INTO client FROM contacts c JOIN pages p ON p.id=c.page_id WHERE c.page_id=NEW.page_id AND c.psid=m#>>'{sender,id}' AND p.fb_page_id=m#>>'{recipient,id}';
 IF client IS NOT NULL THEN PERFORM veo_demographic_enqueue(client);END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER veo_demographic_new_message AFTER UPDATE OF status ON veo_event_inbox FOR EACH ROW WHEN(NEW.status='done' AND OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION veo_demographic_event();
-- Start with the new launch period only. Older contacts can be analyzed on
-- request from their retained excerpts; this never starts a history backfill.
INSERT INTO veo_contact_demographics(contact_id,page_id)
 SELECT c.id,c.page_id FROM contacts c JOIN pages p ON p.id=c.page_id AND p.veo_enabled JOIN veo_tenants t ON t.id=p.veo_tenant_id
 WHERE c.created_at>=t.launch_at AND veo_can_page(t.owner_id,p.id) ON CONFLICT DO NOTHING;
CREATE FUNCTION veo_demographic_access(p_actor uuid,p_contact uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pg uuid;
BEGIN
 SELECT page_id INTO pg FROM contacts WHERE id=p_contact;
 IF pg IS NULL OR NOT veo_can_page(p_actor,pg) THEN RAISE EXCEPTION 'Contact access denied' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('contact_id',p_contact,'page_id',pg,'analysis',(SELECT to_jsonb(d)-'claim_token'-'lease_until' FROM veo_contact_demographics d WHERE contact_id=p_contact),
 'manual_fields',coalesce((SELECT fields FROM veo_contact_details WHERE contact_id=p_contact),'{}'),
 'saved_fields',coalesce((SELECT collected_details FROM chatbot_contact_states WHERE contact_id=p_contact AND page_id=pg),'{}'),
 'ai_demographics',veo_demographic_values(p_contact),
 'extracted_answers',coalesce((SELECT payload->'extracted_answers' FROM contact_profile_snapshots WHERE contact_id=p_contact AND page_id=pg ORDER BY generation DESC LIMIT 1),'[]'));
END $$;
CREATE FUNCTION veo_demographic_action(p_actor uuid,p_contact uuid,p_action text,p_fields jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE before_fields jsonb;pg uuid;tenant uuid;
BEGIN
 PERFORM veo_demographic_access(p_actor,p_contact);
 SELECT c.page_id,p.veo_tenant_id INTO pg,tenant FROM contacts c JOIN pages p ON p.id=c.page_id WHERE c.id=p_contact;
 IF p_action='refresh' THEN PERFORM veo_demographic_enqueue(p_contact,true);
 ELSIF p_action='correct' THEN
 IF jsonb_typeof(p_fields)<>'object' OR length(p_fields::text)>12000 OR EXISTS(SELECT 1 FROM jsonb_each(p_fields) WHERE key NOT IN('age','gender','location','country','region','province','city','industry','business_type','occupation','job_role','preferred_language') OR jsonb_typeof(value)<>'string' OR length(value#>>'{}')>160) THEN RAISE EXCEPTION 'Invalid demographic corrections';END IF;
 INSERT INTO veo_contact_details(contact_id,fields,updated_by) VALUES(p_contact,'{}',p_actor) ON CONFLICT DO NOTHING;
 SELECT fields INTO before_fields FROM veo_contact_details WHERE contact_id=p_contact FOR UPDATE;
 UPDATE veo_contact_details SET fields=fields||p_fields,updated_by=p_actor,updated_at=now() WHERE contact_id=p_contact;
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value) VALUES(tenant,p_actor,'demographics_corrected',p_contact,before_fields,before_fields||p_fields);
 ELSE RAISE EXCEPTION 'Unknown demographic action';END IF;
 RETURN veo_demographic_access(p_actor,p_contact);
END $$;
CREATE FUNCTION veo_demographic_claim(p_limit integer DEFAULT 2) RETURNS SETOF veo_contact_demographics LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 RETURN QUERY WITH due AS(SELECT d.contact_id FROM veo_contact_demographics d JOIN pages p ON p.id=d.page_id AND p.veo_enabled JOIN veo_tenants t ON t.id=p.veo_tenant_id
 WHERE t.launch_at IS NOT NULL AND veo_can_page(t.owner_id,p.id) AND d.next_attempt_at<=now()
 AND(d.status IN('queued','error') OR d.status='processing' AND d.lease_until<now()) ORDER BY d.next_attempt_at LIMIT least(greatest(p_limit,1),5) FOR UPDATE OF d SKIP LOCKED)
 UPDATE veo_contact_demographics d SET status='processing',working_version=requested_version,claim_token=gen_random_uuid(),lease_until=now()+interval '5 minutes',attempts=attempts+1 FROM due WHERE d.contact_id=due.contact_id RETURNING d.*;
END $$;
CREATE FUNCTION veo_demographic_sources(p_contact uuid,p_claim uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH job AS(SELECT d.*,c.psid FROM veo_contact_demographics d JOIN contacts c ON c.id=d.contact_id JOIN pages p ON p.id=d.page_id AND p.veo_enabled JOIN veo_tenants t ON t.id=p.veo_tenant_id
 WHERE d.contact_id=p_contact AND d.claim_token=p_claim AND d.lease_until>now() AND d.status='processing' AND veo_can_page(t.owner_id,p.id)),
 latest AS(SELECT s.* FROM contact_profile_snapshots s JOIN job j ON j.contact_id=s.contact_id AND j.page_id=s.page_id ORDER BY generation DESC LIMIT 1),
 sources AS(SELECT m.message_id AS id,m.sent_at AS at,left(m.text,2500) AS text,'customer' AS sender,'saved_customer_excerpt' AS basis,0 AS priority
 FROM contact_profile_messages m JOIN latest l ON l.contact_id=m.contact_id AND l.page_id=m.page_id AND l.generation=m.generation WHERE m.sender='customer' AND m.text<>''
 UNION ALL SELECT coalesce(e.payload#>>'{entry,0,messaging,0,message,mid}',e.payload#>>'{entry,0,standby,0,message,mid}',e.event_key),e.occurred_at,left(coalesce(e.payload#>>'{entry,0,messaging,0,message,text}',e.payload#>>'{entry,0,standby,0,message,text}'),2500),'customer','launch_period_message',0
 FROM veo_event_inbox e JOIN job j ON j.page_id=e.page_id AND j.psid=coalesce(e.payload#>>'{entry,0,messaging,0,sender,id}',e.payload#>>'{entry,0,standby,0,sender,id}')
 WHERE coalesce(e.payload#>>'{entry,0,messaging,0,message,text}',e.payload#>>'{entry,0,standby,0,message,text}') IS NOT NULL
 UNION ALL SELECT proof->>'message_id',l.source_cutoff_at,left(proof->>'quote',2500),'customer','previously_cited_customer_answer',1
 FROM latest l CROSS JOIN LATERAL jsonb_array_elements(coalesce(l.payload->'extracted_answers','[]')) answer CROSS JOIN LATERAL jsonb_array_elements(coalesce(answer->'evidence','[]')) proof),
 unique_sources AS(SELECT DISTINCT ON(id) id,at,text,sender,basis FROM sources WHERE id IS NOT NULL AND text<>'' ORDER BY id,priority,at DESC),
 bounded AS(SELECT * FROM unique_sources ORDER BY at DESC,id LIMIT 24)
 SELECT jsonb_build_object('messages',coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY at,id) FROM bounded b),'[]'),'coverage','Up to 24 saved customer excerpts and launch-period messages; not complete historical conversation') FROM job
$$;
CREATE FUNCTION veo_demographic_finish(p_contact uuid,p_claim uuid,p_fields jsonb,p_hash text,p_error text DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE job veo_contact_demographics;merged jsonb;
BEGIN
 SELECT * INTO job FROM veo_contact_demographics WHERE contact_id=p_contact AND claim_token=p_claim AND lease_until>now() AND status='processing' FOR UPDATE;
 IF job.contact_id IS NULL OR NOT EXISTS(SELECT 1 FROM pages p JOIN veo_tenants t ON t.id=p.veo_tenant_id WHERE p.id=job.page_id AND p.veo_enabled AND veo_can_page(t.owner_id,p.id)) THEN RETURN false;END IF;
 IF p_error IS NULL AND jsonb_typeof(p_fields)<>'array' THEN RAISE EXCEPTION 'Invalid extracted demographic fields';END IF;
 SELECT coalesce(jsonb_agg(value),'[]') INTO merged FROM(SELECT DISTINCT ON(value->>'field') value FROM(
 SELECT value,0 AS priority FROM jsonb_array_elements(job.fields) UNION ALL SELECT value,1 FROM jsonb_array_elements(coalesce(p_fields,'[]'))) f ORDER BY value->>'field',
 (SELECT max((e->>'at')::timestamptz) FROM jsonb_array_elements(value->'evidence') e) DESC NULLS LAST,priority DESC) selected;
 UPDATE veo_contact_demographics SET fields=CASE WHEN p_error IS NULL THEN merged ELSE fields END,
 status=CASE WHEN p_error IS NOT NULL THEN 'error' WHEN requested_version>working_version THEN 'queued' ELSE 'ready' END,
 analyzed_version=CASE WHEN p_error IS NULL THEN working_version ELSE analyzed_version END,analyzed_at=CASE WHEN p_error IS NULL THEN now() ELSE analyzed_at END,
 source_hash=CASE WHEN p_error IS NULL THEN p_hash ELSE source_hash END,last_error=left(p_error,300),claim_token=NULL,lease_until=NULL,
 next_attempt_at=CASE WHEN p_error IS NOT NULL THEN now()+least(interval '6 hours',interval '1 minute'*power(2,least(attempts,8))) ELSE greatest(next_attempt_at,now()+interval '15 minutes') END WHERE contact_id=p_contact;
 RETURN true;
END $$;
-- Only demographic values, without citations or message text, enter cohort reports.
CREATE OR REPLACE FUNCTION veo_calendar_demographic_fields(p_fields jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(jsonb_object_agg(key,value),'{}') FROM jsonb_each(CASE WHEN jsonb_typeof(p_fields)='object' THEN p_fields ELSE '{}' END)
 WHERE regexp_replace(lower(key),'[ _-]','','g') IN('age','edad','gender','sex','kasarian','city','municipality','location','businesslocation','province','state','country','region','industry','businessindustry','businesstype','businesscategory','businesssubcategory','industrysubcategory','occupation','profession','trabaho','jobrole','jobtitle','role','preferredlanguage','languagepreference')
$$;
DO $$ DECLARE definition text;BEGIN
 definition:=pg_get_functiondef('veo_calendar_inputs(uuid,date,date,date,uuid)'::regprocedure);
 IF strpos(definition,'SELECT l.*,veo_calendar_demographic_fields(d.fields)')=0 THEN RAISE EXCEPTION 'Expected calendar demographic source is missing';END IF;
 EXECUTE replace(definition,'SELECT l.*,veo_calendar_demographic_fields(d.fields)','SELECT l.*,veo_demographic_values(l.id) AS ai_demographics,veo_calendar_demographic_fields(d.fields)');
END $$;
DO $$ DECLARE fn regprocedure;BEGIN
 FOR fn IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'veo_demographic_%' LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn);
 END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
