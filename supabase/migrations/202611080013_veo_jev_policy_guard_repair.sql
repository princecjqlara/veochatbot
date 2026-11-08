BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL jit=off;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='veo_jev_policy'::regclass AND conname='veo_jev_policy_enabled_model_check') THEN
  ALTER TABLE veo_jev_policy ADD CONSTRAINT veo_jev_policy_enabled_model_check CHECK(NOT enabled OR(model_id IS NOT NULL AND length(btrim(model_id))>0));
 END IF;
END $$;
COMMIT;
