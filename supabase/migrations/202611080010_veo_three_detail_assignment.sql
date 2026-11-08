BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL jit=off;
ALTER TABLE veo_intake_dispatch ADD COLUMN details_ready_at timestamptz;
ALTER TABLE veo_intake_dispatch ADD COLUMN checked_at timestamptz;
-- Contacts and their private intake details share the same retention lifecycle.
ALTER TABLE veo_contact_details DROP CONSTRAINT IF EXISTS veo_contact_details_contact_id_fkey;
ALTER TABLE veo_contact_details ADD CONSTRAINT veo_contact_details_contact_id_fkey FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE;
CREATE INDEX veo_intake_dispatch_fair_queue ON veo_intake_dispatch(tenant_id,checked_at NULLS FIRST,eligible_at,id) WHERE status IN('waiting','offered');

-- The persisted, validated intake answers and audited manual corrections are
-- the sources. Alias keys cannot turn one answer into several details.
CREATE FUNCTION veo_intake_progress(p_contact uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH source AS (
  SELECT coalesce((SELECT collected_details FROM chatbot_contact_states WHERE contact_id=p_contact LIMIT 1),'{}'::jsonb)
   ||coalesce((SELECT fields FROM veo_contact_details WHERE contact_id=p_contact),'{}'::jsonb) AS fields
 ), keys AS (
  SELECT lower(regexp_replace(key,'[^a-zA-Z0-9]','','g')) AS key,trim(value) AS value FROM source,jsonb_each_text(fields)
 ), canonical AS (
  SELECT CASE
   WHEN key IN('businessname','companyname','businesscompanyname','pangalanngnegosyo') THEN 'Business Name'
   WHEN key IN('pagesocialmedialink','socialmedialink','pagelink','facebookpage','facebookpagelink','pageurl','sociallink') THEN 'Page / Social Media Link'
   WHEN key IN('businesslocation','businessaddress','companyaddress','location','address','lokasyonngnegosyo') THEN 'Business Location'
   WHEN key IN('goalngvideo','videogoal','videoobjective','goalofthevideo','goalofvideo','videopurpose','purposeofvideo','purpose','objective') THEN 'Goal ng video'
   WHEN key IN('preferredvideolength','videolength','preferredduration','videoduration','duration','length') THEN 'Preferred Video Length'
   WHEN key IN('preferredstyle','videostyle','style','preferredvideostyle') THEN 'Preferred Style'
   WHEN key IN('contactnumber','phonenumber','mobilenumber','telephonenumber','phone','mobile','contactno') THEN 'Contact Number'
   WHEN key IN('portraitorlandscape','orientation','videoorientation','videoformat','format','aspectratio') THEN 'Portrait or Landscape?'
  END AS field,value FROM keys
 ), valid AS (
  SELECT DISTINCT field FROM canonical WHERE field IS NOT NULL AND length(value)>=2
  AND value!~*'^(unknown|not provided|not specified|not stated|not yet provided|n/?a|none|null|undefined|pending|tbd|to be confirmed|to be determined|not sure|unsure|hindi pa alam|wala( pa)?|[-?]+)[.!?[:space:]]*$'
  AND(field<>'Contact Number' OR (value~'^[+0-9 ().-]+$' AND length(regexp_replace(value,'[^0-9]','','g')) BETWEEN 7 AND 15 AND regexp_replace(value,'[^0-9]','','g')!~'^(0+|1+|2+|3+|4+|5+|6+|7+|8+|9+)$'))
  AND(field<>'Page / Social Media Link' OR value~*'^(https?://|www\.)[^[:space:]]+\.[^[:space:]]+')
  AND(field<>'Portrait or Landscape?' OR(value~*'(portrait|vertical|9[ :]*16)' AND value!~*'(landscape|horizontal|16[ :]*9)') OR(value~*'(landscape|horizontal|16[ :]*9)' AND value!~*'(portrait|vertical|9[ :]*16)'))
 ) SELECT jsonb_build_object('detail_count',count(*),'required',3,'eligible',count(*)>=3,'fields',coalesce(jsonb_agg(field ORDER BY field),'[]')) FROM valid
$$;

ALTER FUNCTION veo_intake_action(uuid,text,jsonb) RENAME TO veo_intake_action_before_three_details;
CREATE FUNCTION veo_intake_action(p_actor uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cid uuid;progress jsonb;BEGIN
 IF p_action IN('accept','offer') THEN
  cid:=(p_data->>'contact_id')::uuid;
  IF NOT EXISTS(SELECT 1 FROM contacts WHERE id=cid AND veo_can_page(p_actor,page_id)) THEN RAISE EXCEPTION 'Client Page access denied' USING ERRCODE='42501';END IF;
  PERFORM 1 FROM contacts WHERE id=cid FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM veo_client_claims WHERE contact_id=cid AND user_id IS NOT NULL)
   AND NOT EXISTS(SELECT 1 FROM veo_orders WHERE contact_id=cid)
   AND NOT EXISTS(SELECT 1 FROM veo_closed_deals WHERE contact_id=cid AND voided_at IS NULL) THEN
   progress:=veo_intake_progress(cid);
   IF NOT(progress->>'eligible')::boolean THEN RAISE EXCEPTION 'Collect at least 3 valid client details before offering or accepting this fresh inquiry (%/3 saved)',progress->>'detail_count' USING ERRCODE='23514';END IF;
  END IF;
 END IF;
 RETURN veo_intake_action_before_three_details(p_actor,p_action,p_data);
END $$;

-- Preserve the proven dispatch implementation while adding the shared gate
-- and a fair scan cursor. Fail the migration if its insertion points change.
DO $$ DECLARE definition text;old text;BEGIN
 definition:=pg_get_functiondef('veo_automatic_intake_tick(uuid,timestamptz)'::regprocedure);
 old:='ORDER BY eligible_at,id LIMIT 50 FOR UPDATE LOOP';
 IF strpos(definition,old)=0 THEN RAISE EXCEPTION 'Automatic intake queue implementation changed';END IF;
 definition:=replace(definition,old,'ORDER BY checked_at NULLS FIRST,eligible_at,id LIMIT 50 FOR UPDATE LOOP
  UPDATE veo_intake_dispatch SET checked_at=p_now WHERE id=d.id;');
 old:='  IF d.offer_id IS NOT NULL THEN';
 IF strpos(definition,old)=0 THEN RAISE EXCEPTION 'Automatic intake offer implementation changed';END IF;
 definition:=replace(definition,old,$gate$
  IF NOT(veo_intake_progress(d.contact_id)->>'eligible')::boolean THEN
   UPDATE veo_client_offers SET status='cancelled',ended_at=p_now WHERE id=d.offer_id AND status='pending';
   UPDATE veo_intake_dispatch SET status='waiting',offer_id=NULL,last_error='Collecting client details: '||(veo_intake_progress(d.contact_id)->>'detail_count')||'/3 saved' WHERE id=d.id;
   CONTINUE;
  END IF;
  UPDATE veo_intake_dispatch SET details_ready_at=coalesce(details_ready_at,p_now) WHERE id=d.id;
  IF d.offer_id IS NOT NULL THEN$gate$);
 EXECUTE definition;
END $$;

ALTER FUNCTION veo_intake_notice(uuid,uuid,bigint) RENAME TO veo_intake_notice_before_three_details;
CREATE FUNCTION veo_intake_notice(p_tenant uuid,p_notice uuid,p_chat bigint) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;progress jsonb;BEGIN
 result:=veo_intake_notice_before_three_details(p_tenant,p_notice,p_chat);IF result IS NULL THEN RETURN NULL;END IF;
 SELECT veo_intake_progress(contact_id) INTO progress FROM veo_intake_dispatch WHERE id=p_notice AND tenant_id=p_tenant;
 RETURN result||jsonb_build_object('intake',progress,'text',(result->>'text')||E'\nClient details: '||(progress->>'detail_count')||'/3 saved. No editor offer until at least three valid answers are collected.');
END $$;
ALTER FUNCTION veo_intake_page(uuid,text,uuid,text,integer) RENAME TO veo_intake_page_before_three_details;
CREATE FUNCTION veo_intake_page(p_actor uuid,p_view text DEFAULT 'pool',p_page uuid DEFAULT NULL,p_search text DEFAULT '',p_offset integer DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE result jsonb;BEGIN
 result:=veo_intake_page_before_three_details(p_actor,p_view,p_page,p_search,p_offset);
 RETURN result||jsonb_build_object('items',coalesce((SELECT jsonb_agg(i.value||jsonb_build_object('intake',veo_intake_progress((i.value->>'id')::uuid))) FROM jsonb_array_elements(result->'items') i),'[]'));
END $$;
DO $$ DECLARE fn record;BEGIN
 FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_intake_progress','veo_intake_action','veo_intake_notice','veo_intake_page') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);
 END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
