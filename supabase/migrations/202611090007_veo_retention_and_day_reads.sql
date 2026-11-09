BEGIN;
-- Compacted deduplication keys remain in the inbox. Only eligible, nonempty
-- completed payloads belong in the seven-day cleanup's working index.
CREATE INDEX veo_event_retention_due ON veo_event_inbox(received_at,event_key)
WHERE status='done' AND payload<>'{}'::jsonb;

DO $migration$ DECLARE definition text;marker text;BEGIN
 definition:=replace(pg_get_functiondef('veo_calendar_day_details(uuid,date,uuid)'::regprocedure),E'\r\n',E'\n');
 marker:='WHERE c.page_id=ANY(ids)),';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Expected bounded day cohort is missing';END IF;
 definition:=replace(definition,marker,$bounded$WHERE c.page_id=ANY(ids)
 AND(CASE WHEN s.contact_id IS NOT NULL THEN s.first_inquiry_at ELSE c.first_interaction_at END)>=(p_day-120)::timestamp AT TIME ZONE 'Asia/Manila'
 AND(CASE WHEN s.contact_id IS NOT NULL THEN s.first_inquiry_at ELSE c.first_interaction_at END)<(p_day+1)::timestamp AT TIME ZONE 'Asia/Manila'),$bounded$);
 EXECUTE definition;
END $migration$;
INSERT INTO app_private.schema_migrations(version,description) VALUES('202611090007','Index processed-event retention and bound selected-day sources to their reference window') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
