BEGIN;
SET LOCAL lock_timeout='5s';
-- Reuse every current permission and financial calculation. The workspace
-- already fetches order pages and collection health through separate routes.
DO $$ DECLARE definition text;start_at integer;end_at integer;needle text;BEGIN
 definition:=pg_get_functiondef('veo_dashboard(uuid,date)'::regprocedure);
 start_at:=strpos(definition,'''orders'',');
 end_at:=strpos(substring(definition FROM start_at),'''salary'',')+start_at-1;
 IF start_at=0 OR end_at<=start_at THEN RAISE EXCEPTION 'Dashboard order-list integration changed';END IF;
 definition:=substring(definition FROM 1 FOR start_at-1)||'''orders'',''[]''::jsonb,'||chr(10)||' '||substring(definition FROM end_at);
 start_at:=strpos(definition,'''sync'',');
 end_at:=strpos(substring(definition FROM start_at),' INTO result;')+start_at-1;
 IF start_at=0 OR end_at<=start_at THEN RAISE EXCEPTION 'Dashboard collection-list integration changed';END IF;
 definition:=substring(definition FROM 1 FOR start_at-1)||'''sync'',''[]''::jsonb)'||substring(definition FROM end_at);
 needle:='FUNCTION public.veo_dashboard(';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Dashboard function signature changed';END IF;
 EXECUTE replace(definition,needle,'FUNCTION public.veo_dashboard_summary(');
END $$;
REVOKE ALL ON FUNCTION veo_dashboard_summary(uuid,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_dashboard_summary(uuid,date) TO service_role;
INSERT INTO app_private.schema_migrations(version,description)
 VALUES('202611160002','Read dashboard figures without hydrating unused order and collection lists') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
