BEGIN;
SET LOCAL lock_timeout='5s';
-- PostgREST applies these per-RPC limits at transaction start. They remain
-- below the application's bounded eighteen-second report-read deadline.
ALTER FUNCTION veo_dashboard(uuid,date) SET statement_timeout='15s';
ALTER FUNCTION veo_team_capacity(uuid,date) SET statement_timeout='15s';
INSERT INTO app_private.schema_migrations(version,description)
 VALUES('202611160001','Allow bounded dashboard calculations to complete within the application read deadline') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
