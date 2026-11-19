BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

-- PostgREST 14 retries serialization_failure (40001) without a bound. These
-- stale business-state conflicts cannot succeed on an automatic retry.
-- PT409 preserves the conflict response without starting that retry loop.
DO $migration$
DECLARE item record;definition text;source text;patched text;needle text:='USING ERRCODE=''40001''';
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('public.veo_relink_telegram_pairing(uuid,text,bigint)',1),
  ('public.veo_suspend_member(uuid,uuid,text,integer,text,uuid)',1),
  ('public.veo_discipline_action(uuid,text,jsonb)',3)
 ) expected(signature,occurrences) LOOP
  SELECT prosrc INTO source FROM pg_proc WHERE oid=item.signature::regprocedure;
  IF (length(source)-length(replace(source,needle,'')))/length(needle)<>item.occurrences THEN
   RAISE EXCEPTION 'Unexpected business conflict implementation: %',item.signature;
  END IF;
  definition:=pg_get_functiondef(item.signature::regprocedure);
  patched:=replace(source,needle,'USING ERRCODE=''PT409''');
  EXECUTE replace(definition,source,patched);
 END LOOP;
END $migration$;
NOTIFY pgrst,'reload schema';
COMMIT;
