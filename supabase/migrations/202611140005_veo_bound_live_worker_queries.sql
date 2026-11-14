BEGIN;
-- Historical outage logs also identified event claims and automatic intake
-- ticks repeatedly timing out before the full outage. Keep those transactions
-- below the application's ten-second database request deadline as well.
ALTER FUNCTION veo_claim_events(integer) SET statement_timeout='5s';
ALTER FUNCTION veo_automatic_intake_tick(uuid,timestamptz) SET statement_timeout='8s';
ALTER FUNCTION veo_operations_maintenance() SET statement_timeout='8s';
ALTER FUNCTION veo_maintenance() SET statement_timeout='8s';
INSERT INTO app_private.schema_migrations(version,description) VALUES('202611140005','Bound live event, automatic intake and maintenance database transactions') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
