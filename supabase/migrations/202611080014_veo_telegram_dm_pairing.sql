BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL jit=off;

CREATE TABLE veo_telegram_pairing_codes(
 code_hash text PRIMARY KEY CHECK(code_hash ~ '^[a-f0-9]{64}$'),
 tenant_id uuid NOT NULL REFERENCES veo_tenants(id), telegram_user_id bigint NOT NULL CHECK(telegram_user_id>0),
 chat_id bigint NOT NULL, username text, expires_at timestamptz NOT NULL,
 consumed_by uuid REFERENCES veo_accounts(user_id), consumed_at timestamptz,
 FOREIGN KEY(tenant_id,chat_id) REFERENCES veo_telegram_groups(tenant_id,chat_id)
);
CREATE INDEX veo_telegram_pairing_pending ON veo_telegram_pairing_codes(telegram_user_id,expires_at) WHERE consumed_at IS NULL;

CREATE FUNCTION veo_issue_telegram_pairing(p_tenant uuid,p_hash text,p_telegram bigint,p_chat bigint,p_username text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM veo_tenants WHERE id=p_tenant AND launch_at IS NOT NULL)
 OR NOT EXISTS(SELECT 1 FROM veo_telegram_groups WHERE tenant_id=p_tenant AND chat_id=p_chat AND active)
 OR p_telegram<=0 OR p_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid pairing request' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM veo_worker_mappings WHERE telegram_user_id=p_telegram) THEN RAISE EXCEPTION 'Telegram account already linked' USING ERRCODE='23505'; END IF;
 DELETE FROM veo_telegram_pairing_codes WHERE telegram_user_id=p_telegram AND consumed_at IS NULL;
 INSERT INTO veo_telegram_pairing_codes(code_hash,tenant_id,telegram_user_id,chat_id,username,expires_at)
 VALUES(p_hash,p_tenant,p_telegram,p_chat,nullif(p_username,''),now()+interval '10 minutes');
 RETURN jsonb_build_object('expires_at',now()+interval '10 minutes');
END $$;

CREATE FUNCTION veo_confirm_telegram_pairing(p_actor uuid,p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c veo_telegram_pairing_codes;a veo_accounts;owner uuid;
BEGIN
 SELECT * INTO c FROM veo_telegram_pairing_codes WHERE code_hash=p_hash AND expires_at>now() AND consumed_at IS NULL FOR UPDATE;
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active FOR UPDATE;
 IF a.user_id IS NULL OR c.code_hash IS NULL OR a.tenant_id<>c.tenant_id THEN RAISE EXCEPTION 'Pairing code expired or invalid' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM veo_worker_mappings WHERE user_id=a.user_id AND telegram_user_id<>c.telegram_user_id)
 OR EXISTS(SELECT 1 FROM veo_worker_mappings WHERE telegram_user_id=c.telegram_user_id AND user_id<>a.user_id) THEN RAISE EXCEPTION 'Telegram account already linked' USING ERRCODE='23505'; END IF;
 SELECT owner_id INTO owner FROM veo_tenants WHERE id=a.tenant_id;
 INSERT INTO veo_worker_mappings(user_id,telegram_user_id) VALUES(a.user_id,c.telegram_user_id) ON CONFLICT(user_id) DO NOTHING;
 INSERT INTO veo_telegram_memberships(user_id,tenant_id,chat_id,telegram_user_id,verified_at,verified_by)
 VALUES(a.user_id,a.tenant_id,c.chat_id,c.telegram_user_id,clock_timestamp(),owner)
 ON CONFLICT(user_id,chat_id) DO UPDATE SET telegram_user_id=EXCLUDED.telegram_user_id,verified_at=EXCLUDED.verified_at,verified_by=EXCLUDED.verified_by;
 IF nullif(lower(c.username),'') ~ '^[a-z0-9_]{1,32}$' THEN UPDATE veo_accounts SET telegram_username=lower(c.username),telegram_profile_completed_at=clock_timestamp() WHERE user_id=a.user_id; END IF;
 UPDATE veo_telegram_pairing_codes SET consumed_by=a.user_id,consumed_at=clock_timestamp() WHERE code_hash=p_hash;
 UPDATE veo_telegram_sync_state SET next_sync_at=least(next_sync_at,now()),cursor=0 WHERE tenant_id=a.tenant_id;
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value) VALUES(a.tenant_id,a.user_id,'telegram_self_link',a.user_id,jsonb_build_object('telegram_user_id',c.telegram_user_id,'chat_id',c.chat_id,'method','dm_pairing'));
 RETURN jsonb_build_object('linked',true);
END $$;

ALTER TABLE veo_telegram_pairing_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON veo_telegram_pairing_codes FROM PUBLIC,anon,authenticated;
GRANT ALL ON veo_telegram_pairing_codes TO service_role;
REVOKE ALL ON FUNCTION veo_issue_telegram_pairing(uuid,text,bigint,bigint,text),veo_confirm_telegram_pairing(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_issue_telegram_pairing(uuid,text,bigint,bigint,text),veo_confirm_telegram_pairing(uuid,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
