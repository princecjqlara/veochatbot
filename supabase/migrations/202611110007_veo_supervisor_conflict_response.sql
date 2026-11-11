BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $$ DECLARE definition text;BEGIN
 definition:=pg_get_functiondef('public.veo_change_member_supervisor(uuid,uuid,uuid,uuid)'::regprocedure);
 IF strpos(definition,'Supervisor changed. Refresh Accounts')=0 OR strpos(definition,'USING ERRCODE=''40001''')=0 THEN RAISE EXCEPTION 'Unexpected supervisor conflict implementation';END IF;
 definition:=replace(definition,'USING ERRCODE=''40001''','USING ERRCODE=''23505''');
 EXECUTE definition;
END $$;
ALTER FUNCTION public.veo_change_member_supervisor(uuid,uuid,uuid,uuid) SET jit=off;
ALTER FUNCTION public.veo_change_member_supervisor(uuid,uuid,uuid,uuid) SET plan_cache_mode=force_custom_plan;
ALTER FUNCTION public.veo_change_member_supervisor(uuid,uuid,uuid,uuid) SET lock_timeout='3s';
NOTIFY pgrst,'reload schema';
COMMIT;
