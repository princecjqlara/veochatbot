DO $$
DECLARE p UUID:=gen_random_uuid(); c UUID:=gen_random_uuid();other UUID:=gen_random_uuid();actor UUID;
 result JSONB; cache JSONB; before_epoch INTEGER; checks INTEGER:=0;
BEGIN
 SELECT id INTO actor FROM users LIMIT 1;
 IF actor IS NULL THEN RAISE EXCEPTION 'An existing application member is required for this rolled-back test'; END IF;
 INSERT INTO pages(id,fb_page_id,name,access_token) VALUES(p,'verify-controls-'||p,'Contact Control Verification','not-a-token');
 INSERT INTO user_pages(user_id,page_id) VALUES(actor,p);
 INSERT INTO contacts(id,page_id,psid,name,first_interaction_at,last_inbound_at) VALUES(c,p,'verification-contact','Contact Control Fixture',now()-interval '2 hours',now());
 INSERT INTO chatbot_configs(page_id,enabled) VALUES(p,TRUE);
 INSERT INTO chatbot_contact_states(page_id,contact_id,status,started_at,window_expires_at,collected_details,automation_epoch)
 VALUES(p,c,'active',now(),now()+interval '7 days','{"Business":"Keep this answer"}',7);
 INSERT INTO chatbot_follow_up_jobs(page_id,contact_id,anchor_inbound_at,schedule_type,sequence_index,due_at,message_text,status)
 VALUES(p,c,now(),'response',1,now()+interval '1 hour','Never sent by verification','pending');
 result:=set_contact_bot_permission(p,c,actor,FALSE);
 ASSERT NOT(SELECT chatbot_enabled FROM contacts WHERE id=c),'Off switch not saved';
 ASSERT (SELECT count(*)=0 FROM chatbot_follow_up_jobs WHERE contact_id=c AND status IN('pending','processing','ready_manual','waiting_response')),'Old jobs survived switch off';
 ASSERT (SELECT automation_epoch=8 AND collected_details->>'Business'='Keep this answer' AND status='active' FROM chatbot_contact_states WHERE contact_id=c),'Switch erased intake or did not invalidate generation';
 checks:=checks+3;
 PERFORM set_contact_bot_permission(p,c,actor,FALSE);
 ASSERT (SELECT count(*)=1 FROM contact_bot_permission_events WHERE contact_id=c),'Idempotent off created duplicate audit';checks:=checks+1;
 PERFORM set_contact_bot_permission(p,c,actor,TRUE);
 ASSERT (SELECT chatbot_enabled FROM contacts WHERE id=c),'On switch not saved';
 ASSERT (SELECT count(*)=0 FROM chatbot_follow_up_jobs WHERE contact_id=c AND status='pending'),'On resurrected old jobs';
 ASSERT (SELECT pipeline_stage='new' FROM contacts WHERE id=c),'Switch altered lead stage';checks:=checks+3;
 UPDATE chatbot_configs SET enabled=FALSE WHERE page_id=p;
 result:=get_contact_controls(p,ARRAY[c]);ASSERT result->0->>'reason'='page_disabled','Permission bypassed Page-wide off';checks:=checks+1;
 PERFORM set_contact_bot_permission(p,c,actor,FALSE);
 result:=get_ad_lead_contacts_v2(p,NULL,clock_timestamp(),NULL,FALSE,NULL,'off',25,0);
 ASSERT (result->>'total')::int=1,'Off filter did not include fixture';
 ASSERT (get_ad_lead_contacts_v2(p,NULL,clock_timestamp(),NULL,FALSE,NULL,'on',25,0)->>'total')::int=0,'On filter included disabled contact';checks:=checks+2;
 BEGIN PERFORM set_contact_bot_permission(other,c,actor,TRUE);RAISE EXCEPTION 'Wrong Page accepted';EXCEPTION WHEN raise_exception THEN IF SQLERRM='Wrong Page accepted' THEN RAISE;END IF;END;
 checks:=checks+1;
 cache:=jsonb_build_object('first_inquiry_at',now()-interval '2 hours','source_cutoff_at',now()-interval '1 hour','snapshots','[{"h":0,"i":"Unknown / insufficient business detail","s":"Unknown","b":"initial_inquiry"}]'::jsonb);
 PERFORM save_contact_conversion_cache(p,c,cache);
 PERFORM save_contact_conversion_cache(p,c,cache||jsonb_build_object('source_cutoff_at',now()-interval '90 minutes'));
 ASSERT (SELECT source_cutoff_at=(cache->>'source_cutoff_at')::timestamptz FROM contact_conversion_cache WHERE contact_id=c),'Older concurrent refresh replaced newer evidence';checks:=checks+1;
 ASSERT NOT has_function_privilege('authenticated','public.set_contact_bot_permission(uuid,uuid,uuid,boolean)','EXECUTE'),'Client can bypass membership';
 ASSERT NOT has_table_privilege('anon','public.contact_conversion_cache','SELECT'),'Anonymous projection source access';checks:=checks+2;
 RAISE NOTICE 'Contact controls passed % SQL invariants; every fixture rolls back',checks;
END $$;
