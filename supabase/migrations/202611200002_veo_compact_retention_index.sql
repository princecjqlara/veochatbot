BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';

-- Production builds the replacement online first, then applies this migration
-- after the old copy is removed. No inbox rows, dedupe keys or payloads change.
DO $migration$
DECLARE item oid:=to_regclass('public.veo_event_retention_due');keys integer;
BEGIN
 IF item IS NOT NULL THEN
  SELECT indnkeyatts INTO keys FROM pg_index WHERE indexrelid=item;
  IF keys NOT IN(1,2) OR NOT EXISTS(
   SELECT 1 FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_am am ON am.oid=i.relam
   WHERE x.indexrelid=item AND x.indrelid='public.veo_event_inbox'::regclass AND am.amname='btree'
    AND NOT x.indisunique AND NOT x.indisprimary AND NOT x.indisexclusion AND NOT x.indisreplident
    AND x.indnatts=x.indnkeyatts AND x.indisvalid AND x.indisready AND x.indislive
    AND pg_get_indexdef(item,1,true)='received_at'
    AND(keys=1 OR pg_get_indexdef(item,2,true)='event_key')
    AND pg_get_expr(x.indpred,x.indrelid)='((status = ''done''::text) AND (payload <> ''{}''::jsonb))'
    AND NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conindid=item)
  ) THEN RAISE EXCEPTION 'Unexpected retention index; preserve it for review';END IF;
  IF keys=2 THEN DROP INDEX public.veo_event_retention_due;END IF;
 END IF;
END $migration$;
CREATE INDEX IF NOT EXISTS veo_event_retention_due ON public.veo_event_inbox(received_at)
WHERE status='done' AND payload<>'{}'::jsonb;

-- Preserve the bounded cleanup and its event-key tiebreaker. PostgreSQL can
-- sort equal timestamps after reading the smaller date index.
INSERT INTO app_private.schema_migrations(version,description)
VALUES('202611200002','Narrow the retention working index; retain complete records, dedupe keys and existing retention rules')
ON CONFLICT(version) DO NOTHING;
COMMIT;
