-- Keep welcome-message configuration server-side, like the other Messenger
-- automation configuration tables.

BEGIN;

ALTER TABLE public.welcome_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.welcome_messages FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.welcome_messages TO postgres, service_role;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260921_014', 'Protect welcome-message configuration with RLS')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';

COMMIT;
