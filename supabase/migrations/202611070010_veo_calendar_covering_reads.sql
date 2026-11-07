BEGIN;
-- All-Page reports need these narrow fields from wide, retained contact/event
-- records. Cover the existing Page-bound queries without changing their totals.
CREATE INDEX veo_calendar_contact_base ON contacts(page_id,id)
 INCLUDE(name,psid,pipeline_stage,pipeline_stage_updated_at,first_interaction_at);
CREATE INDEX veo_calendar_meta_stages ON messenger_lead_stage_events(page_id,contact_id,stage,occurred_at)
 WHERE stage IN('converted','qualified');
CREATE INDEX veo_calendar_crm_stages ON ad_lead_stage_events(page_id,contact_id,stage,stage_timestamp)
 WHERE stage IN('converted','qualified');
ANALYZE contacts;
ANALYZE messenger_lead_stage_events;
ANALYZE ad_lead_stage_events;
NOTIFY pgrst,'reload schema';
COMMIT;
