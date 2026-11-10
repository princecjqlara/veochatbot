BEGIN;
SET LOCAL lock_timeout='5s';

-- A linked Telegram user may request fresh proof. Consumption still prevents
-- one Telegram identity from being claimed by a different VEO account.
CREATE OR REPLACE FUNCTION veo_issue_telegram_pairing(p_tenant uuid,p_hash text,p_telegram bigint,p_chat bigint,p_username text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM veo_tenants WHERE id=p_tenant AND launch_at IS NOT NULL)
 OR NOT EXISTS(SELECT 1 FROM veo_telegram_groups WHERE tenant_id=p_tenant AND chat_id=p_chat AND active)
 OR p_telegram IS NULL OR p_telegram<=0 OR p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'Invalid pairing request' USING ERRCODE='42501';END IF;
 DELETE FROM veo_telegram_pairing_codes WHERE telegram_user_id=p_telegram AND consumed_at IS NULL;
 INSERT INTO veo_telegram_pairing_codes(code_hash,tenant_id,telegram_user_id,chat_id,username,expires_at)
 VALUES(p_hash,p_tenant,p_telegram,p_chat,nullif(p_username,''),now()+interval '10 minutes');
 RETURN jsonb_build_object('expires_at',now()+interval '10 minutes');
END $$;

CREATE FUNCTION veo_relink_telegram_pairing(p_actor uuid,p_hash text,p_expected bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a veo_accounts;c veo_telegram_pairing_codes;previous bigint;owner uuid;old_groups jsonb;
BEGIN
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;
 IF a.user_id IS NULL THEN RAISE EXCEPTION 'Active account required' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('veo-telegram-groups:'||a.tenant_id::text,0));
 SELECT w.* INTO a FROM veo_accounts w JOIN users u ON u.id=w.user_id AND u.is_active
 WHERE w.user_id=p_actor AND w.active FOR UPDATE OF w;
 SELECT * INTO c FROM veo_telegram_pairing_codes WHERE code_hash=p_hash AND expires_at>now() AND consumed_at IS NULL FOR UPDATE;
 IF a.user_id IS NULL OR c.code_hash IS NULL OR a.tenant_id<>c.tenant_id
 OR NOT EXISTS(SELECT 1 FROM veo_telegram_groups WHERE tenant_id=a.tenant_id AND chat_id=c.chat_id AND active) THEN
  RAISE EXCEPTION 'Pairing code expired or invalid' USING ERRCODE='42501';END IF;
 SELECT telegram_user_id INTO previous FROM veo_worker_mappings WHERE user_id=a.user_id FOR UPDATE;
 IF previous IS NULL OR p_expected IS DISTINCT FROM previous THEN
  RAISE EXCEPTION 'Telegram link changed; refresh your profile' USING ERRCODE='40001';END IF;
 IF EXISTS(SELECT 1 FROM veo_worker_mappings WHERE telegram_user_id=c.telegram_user_id AND user_id<>a.user_id) THEN
  RAISE EXCEPTION 'Telegram account already linked to another user' USING ERRCODE='23505';END IF;
 SELECT owner_id INTO owner FROM veo_tenants WHERE id=a.tenant_id AND launch_at IS NOT NULL;
 IF owner IS NULL THEN RAISE EXCEPTION 'Workspace is inactive' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(chat_id ORDER BY chat_id),'[]') INTO old_groups FROM veo_telegram_memberships WHERE user_id=a.user_id;
 IF previous<>c.telegram_user_id THEN
  -- These are current identity proofs and automatic grants, not the financial
  -- ledger or historical attendance. Manual Page grants remain authoritative.
  DELETE FROM user_pages p USING veo_telegram_auto_grants g WHERE p.user_id=a.user_id AND g.user_id=p.user_id AND g.page_id=p.page_id;
  DELETE FROM veo_telegram_auto_grants WHERE user_id=a.user_id;
  DELETE FROM veo_telegram_memberships WHERE user_id=a.user_id;
  DELETE FROM veo_telegram_auto_states WHERE user_id=a.user_id;
  UPDATE veo_intake_readiness SET status='busy',expires_at=now(),updated_at=clock_timestamp() WHERE user_id=a.user_id;
 ELSE
  DELETE FROM veo_telegram_group_states WHERE user_id=a.user_id AND chat_id=c.chat_id;
  DELETE FROM veo_telegram_auto_states WHERE user_id=a.user_id AND chat_id=c.chat_id;
 END IF;
 UPDATE veo_worker_mappings SET telegram_user_id=c.telegram_user_id WHERE user_id=a.user_id;
 INSERT INTO veo_telegram_memberships(user_id,tenant_id,chat_id,telegram_user_id,verified_at,verified_by)
 VALUES(a.user_id,a.tenant_id,c.chat_id,c.telegram_user_id,clock_timestamp(),owner)
 ON CONFLICT(user_id,chat_id) DO UPDATE SET telegram_user_id=EXCLUDED.telegram_user_id,verified_at=EXCLUDED.verified_at,verified_by=EXCLUDED.verified_by;
 UPDATE veo_accounts SET telegram_username=CASE WHEN lower(c.username) ~ '^[a-z0-9_]{1,32}$' THEN lower(c.username) ELSE NULL END,
 telegram_profile_completed_at=clock_timestamp() WHERE user_id=a.user_id;
 UPDATE veo_telegram_pairing_codes SET consumed_by=a.user_id,consumed_at=clock_timestamp() WHERE code_hash=p_hash;
 DELETE FROM veo_telegram_link_codes WHERE user_id=a.user_id;
 UPDATE veo_telegram_sync_state SET next_sync_at=least(next_sync_at,now()),cursor=0,auto_cursor=0 WHERE tenant_id=a.tenant_id;
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value)
 VALUES(a.tenant_id,a.user_id,'telegram_self_relink',a.user_id,
 jsonb_build_object('telegram_user_id',previous,'chat_ids',old_groups),
 jsonb_build_object('telegram_user_id',c.telegram_user_id,'chat_id',c.chat_id,'method','dm_pairing'));
 RETURN jsonb_build_object('linked',true,'telegram_user_id',c.telegram_user_id::text);
END $$;
REVOKE ALL ON FUNCTION veo_issue_telegram_pairing(uuid,text,bigint,bigint,text),veo_relink_telegram_pairing(uuid,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_issue_telegram_pairing(uuid,text,bigint,bigint,text),veo_relink_telegram_pairing(uuid,text,bigint) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
