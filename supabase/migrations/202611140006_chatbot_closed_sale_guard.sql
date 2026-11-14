BEGIN;
SET LOCAL lock_timeout='3s';
CREATE FUNCTION chatbot_contact_sales_stop(p_page uuid,p_contact uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET statement_timeout='3s' AS $$
 SELECT CASE WHEN c.pipeline_stage='converted' THEN 'converted'
  WHEN c.pipeline_stage='order_created' OR EXISTS(SELECT 1 FROM veo_orders o WHERE o.contact_id=c.id AND o.page_id=c.page_id)
   OR EXISTS(SELECT 1 FROM contact_purchases o WHERE o.contact_id=c.id AND o.page_id=c.page_id) THEN 'order_created' END
 FROM contacts c WHERE c.id=p_contact AND c.page_id=p_page
$$;

-- Closing a sale or switching a contact off invalidates queued work in the
-- same transaction. Preserve answers and financial records.
CREATE FUNCTION stop_closed_contact_automation(p_page uuid,p_contact uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE reason text;permission boolean;BEGIN
 SELECT chatbot_enabled INTO permission FROM contacts WHERE id=p_contact AND page_id=p_page;
 IF NOT FOUND THEN RETURN;END IF;
 reason:=chatbot_contact_sales_stop(p_page,p_contact);
 IF reason IS NULL AND permission IS NOT FALSE THEN RETURN;END IF;
 IF reason IS NOT NULL THEN
 INSERT INTO chatbot_contact_states(page_id,contact_id,status,stop_reason,stopped_at,pause_kind,automation_epoch)
 VALUES(p_page,p_contact,'stopped',reason,clock_timestamp(),'explicit_hold',1)
 ON CONFLICT(page_id,contact_id) DO UPDATE SET status='stopped',stop_reason=excluded.stop_reason,pause_kind='explicit_hold',
  stopped_at=coalesce(chatbot_contact_states.stopped_at,excluded.stopped_at),automation_epoch=chatbot_contact_states.automation_epoch+1,updated_at=clock_timestamp()
 WHERE chatbot_contact_states.status IS DISTINCT FROM 'stopped' OR chatbot_contact_states.stop_reason IS DISTINCT FROM excluded.stop_reason OR chatbot_contact_states.pause_kind IS DISTINCT FROM 'explicit_hold';
 ELSE
  UPDATE chatbot_contact_states SET automation_epoch=automation_epoch+1,updated_at=clock_timestamp() WHERE page_id=p_page AND contact_id=p_contact;
 END IF;
 UPDATE chatbot_follow_up_jobs SET status='cancelled',cancelled_at=clock_timestamp(),claimed_at=NULL,
  error_message='Contact bot is off or this client already has an order',updated_at=clock_timestamp()
 WHERE page_id=p_page AND contact_id=p_contact AND status IN('pending','processing','ready_manual','waiting_response');
 UPDATE chatbot_continuation_reviews SET status='skipped',claimed_at=NULL,reviewed_at=clock_timestamp(),error_message='Contact bot is off or this client already has an order'
 WHERE page_id=p_page AND contact_id=p_contact AND status IN('pending','processing');
END $$;
CREATE FUNCTION stop_contact_automation_after_sale() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN PERFORM stop_closed_contact_automation(NEW.page_id,NEW.contact_id);RETURN NEW;END $$;
CREATE TRIGGER chatbot_stop_after_veo_order AFTER INSERT ON veo_orders FOR EACH ROW EXECUTE FUNCTION stop_contact_automation_after_sale();
CREATE TRIGGER chatbot_stop_after_purchase AFTER INSERT ON contact_purchases FOR EACH ROW EXECUTE FUNCTION stop_contact_automation_after_sale();
CREATE FUNCTION stop_contact_automation_after_control() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.pipeline_stage IS DISTINCT FROM OLD.pipeline_stage OR NEW.chatbot_enabled IS DISTINCT FROM OLD.chatbot_enabled THEN
  PERFORM stop_closed_contact_automation(NEW.page_id,NEW.id);
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER chatbot_stop_after_contact_control AFTER UPDATE OF pipeline_stage,chatbot_enabled ON contacts FOR EACH ROW EXECUTE FUNCTION stop_contact_automation_after_control();

-- A trial reset must not silently reopen a converted/ordered customer.
ALTER FUNCTION reset_chatbot_contact(uuid,uuid) RENAME TO reset_chatbot_contact_before_sale_guard;
CREATE FUNCTION reset_chatbot_contact(p_page_id uuid,p_contact_id uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM contacts WHERE id=p_contact_id AND page_id=p_page_id FOR UPDATE;
 IF chatbot_contact_sales_stop(p_page_id,p_contact_id) IS NOT NULL THEN RAISE EXCEPTION 'This client is converted or already has an order. Automatic sales replies remain stopped.' USING ERRCODE='42501';END IF;
 RETURN reset_chatbot_contact_before_sale_guard(p_page_id,p_contact_id);
END $$;

-- Workspace Page access is inherited through teams, unlike legacy user_pages.
CREATE OR REPLACE FUNCTION set_contact_bot_permission(p_page_id uuid,p_contact_id uuid,p_actor_id uuid,p_enabled boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE old_permission boolean;cancelled integer:=0;BEGIN
 IF p_enabled IS NULL OR NOT EXISTS(SELECT 1 FROM pages p WHERE p.id=p_page_id AND
  ((p.veo_enabled AND veo_can_page(p_actor_id,p.id)) OR (NOT coalesce(p.veo_enabled,false) AND EXISTS(SELECT 1 FROM user_pages WHERE page_id=p_page_id AND user_id=p_actor_id)))) THEN RAISE EXCEPTION 'Page membership required' USING ERRCODE='42501';END IF;
 SELECT chatbot_enabled INTO old_permission FROM contacts WHERE id=p_contact_id AND page_id=p_page_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Contact not found';END IF;
 IF old_permission IS DISTINCT FROM p_enabled OR NOT p_enabled THEN
  SELECT count(*)::int INTO cancelled FROM chatbot_follow_up_jobs WHERE page_id=p_page_id AND contact_id=p_contact_id AND status IN('pending','processing','ready_manual','waiting_response');
  IF old_permission IS DISTINCT FROM p_enabled THEN
   UPDATE contacts SET chatbot_enabled=p_enabled,updated_at=clock_timestamp() WHERE id=p_contact_id AND page_id=p_page_id;
   INSERT INTO contact_bot_permission_events(page_id,contact_id,actor_id,enabled) VALUES(p_page_id,p_contact_id,p_actor_id,p_enabled);
  END IF;
  IF p_enabled THEN UPDATE chatbot_contact_states SET automation_epoch=automation_epoch+1,updated_at=clock_timestamp() WHERE page_id=p_page_id AND contact_id=p_contact_id;
  ELSIF old_permission IS NOT DISTINCT FROM p_enabled THEN PERFORM stop_closed_contact_automation(p_page_id,p_contact_id);END IF;
  UPDATE chatbot_follow_up_jobs SET status='cancelled',cancelled_at=clock_timestamp(),claimed_at=NULL,error_message='Contact bot permission changed',updated_at=clock_timestamp()
   WHERE page_id=p_page_id AND contact_id=p_contact_id AND status IN('pending','processing','ready_manual','waiting_response');
 END IF;
 RETURN jsonb_build_object('enabled',p_enabled,'changed',old_permission IS DISTINCT FROM p_enabled,'cancelled_follow_ups',cancelled);
END $$;
DO $$ DECLARE definition text;BEGIN
 definition:=pg_get_functiondef('get_contact_controls(uuid,uuid[])'::regprocedure);
 -- pg_get_functiondef preserves SQL source rather than deparsing it.
 IF strpos(definition,'WHEN c.pipeline_stage IN (''converted'',''not_qualified'',''order_created'',''opted_out'')')>0 THEN
  definition:=replace(definition,'WHEN c.pipeline_stage IN (''converted'',''not_qualified'',''order_created'',''opted_out'')','WHEN chatbot_contact_sales_stop(c.page_id,c.id) IS NOT NULL OR c.pipeline_stage IN(''not_qualified'',''opted_out'')');
 ELSE RAISE EXCEPTION 'Contact control implementation changed';END IF;
 EXECUTE definition;
END $$;

DO $$ DECLARE closed_client record;BEGIN
 FOR closed_client IN SELECT id,page_id FROM contacts c WHERE c.pipeline_stage IN('converted','order_created') OR NOT c.chatbot_enabled
  OR EXISTS(SELECT 1 FROM veo_orders o WHERE o.contact_id=c.id AND o.page_id=c.page_id)
  OR EXISTS(SELECT 1 FROM contact_purchases o WHERE o.contact_id=c.id AND o.page_id=c.page_id)
 LOOP PERFORM stop_closed_contact_automation(closed_client.page_id,closed_client.id);END LOOP;
END $$;
REVOKE ALL ON FUNCTION chatbot_contact_sales_stop(uuid,uuid),stop_closed_contact_automation(uuid,uuid),stop_contact_automation_after_sale(),stop_contact_automation_after_control(),reset_chatbot_contact(uuid,uuid),reset_chatbot_contact_before_sale_guard(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chatbot_contact_sales_stop(uuid,uuid),reset_chatbot_contact(uuid,uuid) TO service_role;
-- Keep the reset implementation private; only the guarded entry point is exposed.
REVOKE ALL ON FUNCTION reset_chatbot_contact_before_sale_guard(uuid,uuid) FROM service_role;
INSERT INTO app_private.schema_migrations(version,description) VALUES('202611140006','Stop automated sales replies for saved orders, converted leads and individual bot-off controls') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
