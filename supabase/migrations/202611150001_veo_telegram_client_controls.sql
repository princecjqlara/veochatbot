BEGIN;
SET LOCAL lock_timeout='5s';
-- Keep the authoritative assignment checks and the existing bound tokens.
-- Navigation and availability buttons are reusable; assignment mutations
-- retain their single-result guard. Telegram update IDs still fence retries.
DO $$ DECLARE definition text;needle text;BEGIN
 definition:=pg_get_functiondef('veo_telegram_intake(uuid,bigint,bigint,text,jsonb)'::regprocedure);
 needle:='IF token.result_request_id IS NOT NULL THEN RETURN';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Telegram token implementation changed';END IF;
 definition:=replace(definition,needle,'IF token.result_request_id IS NOT NULL AND token.action IN(''accept'',''decline'',''cancel'',''offer'') THEN RETURN');

 needle:='IF r.kind=''pool'' AND scope->>''role'' IN(''member'',''manager'') OR c->>''offered_to''=actor::text AND c->''offer_authorized''=''true''::jsonb THEN';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Telegram acceptance rendering changed';END IF;
 definition:=replace(definition,needle,$patch$IF (r.kind='pool' AND scope->>'role' IN('member','manager')
     AND c->'intake'->'eligible'='true'::jsonb
     AND coalesce(c->'auto_assignment'->>'status','') NOT IN('waiting','offered'))
    OR (c->>'offered_to'=actor::text AND c->'offer_authorized'='true'::jsonb) THEN$patch$);

 needle:='IF c->''can_offer''=''true''::jsonb THEN row_buttons:=';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Telegram offer rendering changed';END IF;
 definition:=replace(definition,needle,$patch$IF c->'can_offer'='true'::jsonb AND (c->>'owner_id' IS NOT NULL OR
     (c->'intake'->'eligible'='true'::jsonb AND coalesce(c->'auto_assignment'->>'status','') NOT IN('waiting','offered'))) THEN row_buttons:=$patch$);

 needle:='row_buttons:=''[]'';';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Telegram client rendering changed';END IF;
 definition:=replace(definition,needle,$patch$row_buttons:='[]';
   IF c->>'owner_id' IS NULL AND coalesce(c->'auto_assignment'->>'status','') IN('waiting','offered') THEN
    lines:=lines||E'\n  Waiting for your automatic editor offer. Use /ready to join the queue.';
   ELSIF c->>'owner_id' IS NULL AND c->'intake'->'eligible' IS DISTINCT FROM 'true'::jsonb THEN
    lines:=lines||E'\n  Collecting client details ('||coalesce(c->'intake'->>'detail_count','0')||'/3).';
   END IF;$patch$);

 needle:='RETURN jsonb_build_object(''request_id'',req,''chat_id'',p_chat,''telegram_user_id'',p_telegram);'||chr(10)||' END IF;';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Telegram result implementation changed';END IF;
 definition:=replace(definition,needle,$patch$RETURN jsonb_build_object('request_id',req,'chat_id',p_chat,'telegram_user_id',p_telegram,
   'feedback',CASE coalesce(token.action,p_action)
    WHEN 'accept' THEN 'Client accepted. Your status is now Busy. Open My clients to continue.'
    WHEN 'ready' THEN 'You are Ready for a client. Ready ends when you choose Busy, accept a client, or at Philippine midnight.'
    WHEN 'busy' THEN 'You are Busy. Pending offers to you have been cancelled.'
    WHEN 'offer' THEN 'Client offered. The current owner keeps the client until the worker accepts.'
    ELSE 'Your refreshed client controls will appear here shortly.' END);
 END IF;$patch$);
 -- Some retained deployments stored literal backslash-n in this function.
 definition:=replace(definition,chr(92)||chr(92)||'n',chr(92)||'n');
 EXECUTE definition;
END $$;
INSERT INTO app_private.schema_migrations(version,description)
 VALUES('202611150001','Repair reusable Telegram client controls and render only authorized acceptance actions') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
