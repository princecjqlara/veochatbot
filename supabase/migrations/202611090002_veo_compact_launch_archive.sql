BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='10s';

-- Profiles already have versioned storage. A launch must not make a second
-- full copy of every historical profile payload in the immutable archive.
-- Existing archives, original profiles, contacts, tags and finance stay intact.
DO $$
DECLARE
 definition text;
 original_list text := $old$ARRAY['contacts','campaigns','contact_purchases','contact_verified_payments','chatbot_contact_states','contact_profile_snapshots','page_activity_history']$old$;
 compact_list text := $new$ARRAY['contacts','campaigns','contact_purchases','contact_verified_payments','chatbot_contact_states','page_activity_history']$new$;
BEGIN
 SELECT pg_get_functiondef('public.veo_launch(uuid,uuid[])'::regprocedure) INTO definition;
 IF strpos(definition,original_list)>0 THEN
  EXECUTE replace(definition,original_list,compact_list);
 ELSIF strpos(definition,compact_list)=0 THEN
  RAISE EXCEPTION 'Unexpected workspace launch archive definition; inspect before changing';
 END IF;
END $$;

INSERT INTO app_private.schema_migrations(version,description)
VALUES('202611090002','Avoid duplicate historical profile payloads at future workspace launches')
ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
