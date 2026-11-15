BEGIN;
SET LOCAL lock_timeout='5s';
-- Keep all authorization, expiry, ownership and idempotency checks in the
-- existing implementation. Only the presentation of new replies changes.
ALTER FUNCTION veo_telegram_intake(uuid,bigint,bigint,text,jsonb) RENAME TO veo_telegram_intake_before_command_controls;
CREATE FUNCTION veo_telegram_intake(p_tenant uuid,p_telegram bigint,p_chat bigint,p_action text,p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off SET plan_cache_mode=force_custom_plan AS $$
DECLARE result jsonb;kind text;row_buttons jsonb;button jsonb;kept jsonb;buttons jsonb:='[]';token veo_telegram_intake_tokens;
BEGIN
 result:=veo_telegram_intake_before_command_controls(p_tenant,p_telegram,p_chat,p_action,p_data);
 IF p_action IN('render','render_offer') THEN
  SELECT r.kind INTO kind FROM veo_telegram_intake_requests r WHERE r.id=(result->>'request_id')::uuid;
  IF kind IN('reassign','choose_worker') THEN
   result:=result||jsonb_build_object('text','Use the VEO workspace to manage handovers and reassignments: https://veochatbot.vercel.app/dashboard/workspace?view=new_clients');
  END IF;
  FOR row_buttons IN SELECT value FROM jsonb_array_elements(coalesce(result->'reply_markup'->'inline_keyboard','[]')) LOOP
   kept:='[]';
   FOR button IN SELECT value FROM jsonb_array_elements(row_buttons) LOOP
    IF coalesce(button->>'callback_data','') !~ '^vi:[0-9a-f-]{36}$' THEN CONTINUE;END IF;
    SELECT t.* INTO token FROM veo_telegram_intake_tokens t
     WHERE t.id=substring(button->>'callback_data' FROM 4)::uuid;
    IF token.offer_id IS NULL OR token.action NOT IN('accept','decline') THEN CONTINUE;END IF;
    kept:=kept||jsonb_build_array(button||jsonb_build_object('text',CASE token.action WHEN 'accept' THEN 'Accept client' ELSE 'Remove from list' END));
   END LOOP;
   IF jsonb_array_length(kept)>0 THEN buttons:=buttons||jsonb_build_array(kept);END IF;
  END LOOP;
  result:=result||jsonb_build_object('reply_markup',jsonb_build_object('inline_keyboard',buttons),
   'text',left(result->>'text',2800)||E'\n\nUse /ready to receive an automatic editor offer, or /busy when unavailable. Use /offers for current offers and /myclients for accepted clients.'||
    CASE WHEN jsonb_array_length(buttons)>0 THEN E'\nAccept client confirms ownership and sets you Busy. Remove from list declines your offer; the client remains available for reassignment.' ELSE '' END);
 ELSE
  result:=result||CASE WHEN result->>'feedback' LIKE 'Client accepted.%' THEN jsonb_build_object('feedback','Client accepted. Your status is now Busy. Use /myclients to continue.')
   WHEN result->>'feedback' IS NOT NULL AND p_action='callback' AND EXISTS(
    SELECT 1 FROM veo_telegram_intake_tokens WHERE id=(p_data->>'token_id')::uuid AND action='decline')
    THEN jsonb_build_object('feedback','Offer removed from your list. The client remains available for reassignment.') ELSE '{}'::jsonb END;
 END IF;
 RETURN result;
END $$;
ALTER FUNCTION veo_intake_notice(uuid,uuid,bigint) RENAME TO veo_intake_notice_before_command_controls;
CREATE FUNCTION veo_intake_notice(p_tenant uuid,p_notice uuid,p_chat bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;BEGIN
 result:=veo_intake_notice_before_command_controls(p_tenant,p_notice,p_chat);
 IF result IS NULL THEN RETURN NULL;END IF;
 RETURN result||jsonb_build_object('reply_markup',jsonb_build_object('inline_keyboard','[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION veo_telegram_intake(uuid,bigint,bigint,text,jsonb),veo_intake_notice(uuid,uuid,bigint),veo_telegram_intake_before_command_controls(uuid,bigint,bigint,text,jsonb),veo_intake_notice_before_command_controls(uuid,uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_telegram_intake(uuid,bigint,bigint,text,jsonb),veo_intake_notice(uuid,uuid,bigint),veo_telegram_intake_before_command_controls(uuid,bigint,bigint,text,jsonb),veo_intake_notice_before_command_controls(uuid,uuid,bigint) TO service_role;
INSERT INTO app_private.schema_migrations(version,description)
 VALUES('202611150002','Use Telegram availability commands and retain only offer acceptance and decline controls') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
