BEGIN;
-- DISTINCT must not include a volatile timestamp: multiple orders belonging to
-- one client can otherwise become multiple conflicting release rows.
DO $migration$ DECLARE definition text; previous text; BEGIN
 definition:=pg_get_functiondef('veo_offboard(uuid,uuid,text,text)'::regprocedure);
 previous:='SELECT DISTINCT o.contact_id,o.tenant_id,o.page_id,NULL::uuid,p_user,clock_timestamp(),p_reason';
 IF strpos(definition,previous)=0 THEN RAISE EXCEPTION 'Expected client release source before patching'; END IF;
 EXECUTE replace(definition,previous,'SELECT DISTINCT o.contact_id,o.tenant_id,o.page_id,NULL::uuid,p_user,statement_timestamp(),p_reason');
END $migration$;
NOTIFY pgrst,'reload schema';
COMMIT;
