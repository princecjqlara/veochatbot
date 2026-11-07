BEGIN;
-- Give the parameter-specific planner scalar role/tenant values. Composite
-- account field expressions otherwise retain costly branch alternatives.
-- Authorization, Page grants and every source/report expression stay intact.
DO $migration$ DECLARE definition text;main_at integer;BEGIN
 definition:=replace(pg_get_functiondef('veo_calendar_inputs(uuid,date,date,date,uuid)'::regprocedure),E'\r\n',E'\n');
 IF strpos(definition,'DECLARE actor veo_accounts;')=0 THEN RAISE EXCEPTION 'Expected calendar account declaration is missing';END IF;
 definition:=replace(definition,'DECLARE actor veo_accounts;','DECLARE scoped_role text;scoped_tenant uuid;actor veo_accounts;');
 main_at:=strpos(definition,' WITH cohort_base AS MATERIALIZED(');
 IF main_at=0 THEN RAISE EXCEPTION 'Expected bounded calendar source is missing';END IF;
 definition:=left(definition,main_at-1)||' scoped_role:=actor.role;scoped_tenant:=actor.tenant_id;'||
 replace(replace(substr(definition,main_at),'actor.role','scoped_role'),'actor.tenant_id','scoped_tenant');
 EXECUTE definition;
END $migration$;
NOTIFY pgrst,'reload schema';
COMMIT;
