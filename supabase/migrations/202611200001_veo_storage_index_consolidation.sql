BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';

-- Keep the existing covering/unique indexes. The three ordinary copies add
-- storage and write work without supplying another search key or constraint.
-- The production release prepares these drops online before recording this
-- migration. Fresh installations and local SQL tests can apply it directly.
DO $migration$
DECLARE redundant text;retained text;old_oid oid;keep_oid oid;
BEGIN
 FOR redundant,retained IN SELECT * FROM(VALUES
  ('idx_contacts_conversion_first','idx_contacts_calendar_inquiry'),
  ('idx_pages_fb_page_id','pages_fb_page_id_key'),
  ('idx_users_email','users_email_key')
 ) pairs(redundant,retained) LOOP
  old_oid:=to_regclass('public.'||redundant);
  keep_oid:=to_regclass('public.'||retained);
  IF NOT EXISTS(SELECT 1 FROM pg_index b WHERE b.indexrelid=keep_oid AND b.indisvalid AND b.indisready AND b.indislive) THEN
   RAISE EXCEPTION 'Required retained index is unavailable: %',retained;
  END IF;
  IF old_oid IS NULL THEN CONTINUE;END IF;
  IF NOT EXISTS(
   SELECT 1 FROM pg_index a JOIN pg_index b ON b.indexrelid=keep_oid
   JOIN pg_class ia ON ia.oid=a.indexrelid JOIN pg_class ib ON ib.oid=b.indexrelid
   JOIN pg_am am ON am.oid=ia.relam
   WHERE a.indexrelid=old_oid AND a.indrelid=b.indrelid AND ia.relam=ib.relam AND am.amname='btree'
    AND NOT a.indisunique AND NOT a.indisprimary AND NOT a.indisexclusion AND NOT a.indisreplident
    AND a.indnkeyatts=b.indnkeyatts AND a.indclass=b.indclass AND a.indcollation=b.indcollation AND a.indoption=b.indoption
    AND a.indpred IS NULL AND b.indpred IS NULL AND a.indexprs IS NULL AND b.indexprs IS NULL
    AND NOT EXISTS(SELECT 1 FROM generate_series(0,a.indnkeyatts-1) n WHERE a.indkey[n]<>b.indkey[n])
    AND a.indkey::smallint[]<@b.indkey::smallint[]
    AND NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conindid=a.indexrelid)
  ) THEN RAISE EXCEPTION 'Redundant index is not fully covered: %',redundant;END IF;
 END LOOP;
END $migration$;

DROP INDEX IF EXISTS public.idx_contacts_conversion_first;
DROP INDEX IF EXISTS public.idx_pages_fb_page_id;
DROP INDEX IF EXISTS public.idx_users_email;

INSERT INTO app_private.schema_migrations(version,description)
VALUES('202611200001','Consolidate three redundant indexes while retaining covering indexes, uniqueness and all business records')
ON CONFLICT(version) DO NOTHING;
COMMIT;
