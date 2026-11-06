BEGIN;
-- A leader's saved primary group must still belong to a current team in their
-- branch. An old observation after a team remap cannot end their employment.
CREATE FUNCTION veo_current_telegram_group(p_user uuid) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN a.role='team_leader' THEN(SELECT g.telegram_chat_id FROM veo_staff_telegram_groups g WHERE g.user_id=a.user_id AND EXISTS(
 SELECT 1 FROM veo_teams t WHERE t.tenant_id=a.tenant_id AND t.telegram_chat_id=g.telegram_chat_id AND t.manager_id IN(SELECT veo_branch(a.user_id))
 AND EXISTS(SELECT 1 FROM veo_accounts w WHERE w.active AND(w.user_id=t.manager_id OR w.parent_id=t.manager_id))))
 WHEN a.role IN('manager','member') THEN(SELECT t.telegram_chat_id FROM veo_teams t WHERE t.tenant_id=a.tenant_id AND t.manager_id=CASE WHEN a.role='manager' THEN a.user_id ELSE a.parent_id END) END
 FROM veo_accounts a WHERE a.user_id=p_user AND a.active
$$;
DO $migration$ DECLARE definition text; previous text; BEGIN
 definition:=pg_get_functiondef('veo_apply_telegram_observations(uuid,jsonb)'::regprocedure);
 previous:=$old$SELECT CASE WHEN account.role='team_leader' THEN(SELECT telegram_chat_id FROM veo_staff_telegram_groups WHERE user_id=account.user_id)
 ELSE(SELECT telegram_chat_id FROM veo_teams WHERE manager_id=CASE WHEN account.role='manager' THEN account.user_id ELSE account.parent_id END) END INTO chat;$old$;
 IF strpos(definition,previous)=0 THEN RAISE EXCEPTION 'Expected Telegram group authorization before patching'; END IF;
 EXECUTE replace(definition,previous,'chat:=veo_current_telegram_group(account.user_id);');
END $migration$;
REVOKE ALL ON FUNCTION veo_current_telegram_group(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_current_telegram_group(uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
