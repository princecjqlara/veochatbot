BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
-- The coordinator performs short, independently committed worker requests.
-- Its lease must outlast the 120-second HTTP limit, including cleanup grace.
DO $migration$
DECLARE definition text;needle text:='WHEN p_job=''quotas'' THEN interval ''90 seconds''';
BEGIN
 definition:=pg_get_functiondef('public.veo_claim_background_job(text,uuid)'::regprocedure);
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Quota coordinator lease integration point changed';END IF;
 EXECUTE replace(definition,needle,'WHEN p_job=''quotas'' THEN interval ''150 seconds''');
END $migration$;
INSERT INTO app_private.schema_migrations(version,description) VALUES('202611160008','Quota coordinator lease covers its bounded HTTP run and cleanup grace') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
