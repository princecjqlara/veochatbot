BEGIN;
SET LOCAL lock_timeout='5s';

-- Marketing API access is a user credential, not a Page token. Keep it
-- encrypted by the application and readable only through service_role.
CREATE TABLE IF NOT EXISTS public.meta_ads_credentials (
 user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
 token_ciphertext TEXT NOT NULL,
 token_iv TEXT NOT NULL,
 token_auth_tag TEXT NOT NULL,
 token_expires_at TIMESTAMPTZ,
 permissions TEXT[] NOT NULL DEFAULT '{}',
 last_synced_at TIMESTAMPTZ,
 last_error TEXT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.meta_ads_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.meta_ads_credentials FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.meta_ads_credentials TO service_role;

CREATE TABLE IF NOT EXISTS public.meta_ads_sync_state (
 user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 account_id TEXT NOT NULL CHECK(account_id ~ '^[0-9]{1,100}$'),
 next_window_start DATE,
 last_inventory_at TIMESTAMPTZ,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,account_id)
);
ALTER TABLE public.meta_ads_sync_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.meta_ads_sync_state FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.meta_ads_sync_state TO service_role;

INSERT INTO app_private.schema_migrations(version,description)
VALUES('202611040002','Encrypted Meta Ads credentials and resumable scheduled spend sync')
ON CONFLICT DO NOTHING;
COMMIT;
