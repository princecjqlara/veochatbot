BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL jit=off;
ALTER TABLE veo_jev_policy ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'observe';
DO $$ DECLARE c record;BEGIN
 ALTER TABLE veo_jev_policy DROP CONSTRAINT IF EXISTS veo_jev_policy_mode_check;
 ALTER TABLE veo_jev_policy ADD CONSTRAINT veo_jev_policy_mode_check CHECK(mode IN('observe','active'));
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='veo_jev_reviews'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%status%' LOOP
  EXECUTE format('ALTER TABLE veo_jev_reviews DROP CONSTRAINT %I',c.conname);
 END LOOP;
 ALTER TABLE veo_jev_reviews ADD CONSTRAINT veo_jev_reviews_status_check CHECK(status IN('pending','processing','wait','observed','resumed','follow_up','stopped','skipped','failed'));
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='veo_jev_policy'::regclass AND conname='veo_jev_policy_enabled_model_check') THEN
  ALTER TABLE veo_jev_policy ADD CONSTRAINT veo_jev_policy_enabled_model_check CHECK(NOT enabled OR(model_id IS NOT NULL AND length(btrim(model_id))>0));
 END IF;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
