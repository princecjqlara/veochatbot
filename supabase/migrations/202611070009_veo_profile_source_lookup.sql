BEGIN;
-- Saved-source extraction must seek this customer's events instead of reading
-- every large webhook payload on each queued profile. No history is imported.
CREATE INDEX veo_event_profile_sources ON veo_event_inbox(
 page_id,(coalesce(payload#>>'{entry,0,messaging,0,sender,id}',payload#>>'{entry,0,standby,0,sender,id}')))
 WHERE coalesce(payload#>>'{entry,0,messaging,0,message,text}',payload#>>'{entry,0,standby,0,message,text}') IS NOT NULL;
ALTER FUNCTION veo_demographic_sources_base(uuid,uuid) SET plan_cache_mode='force_custom_plan';
ALTER FUNCTION veo_demographic_sources_base(uuid,uuid) SET jit='off';
ALTER FUNCTION veo_demographic_sources(uuid,uuid) SET plan_cache_mode='force_custom_plan';
ALTER FUNCTION veo_demographic_sources(uuid,uuid) SET jit='off';
NOTIFY pgrst,'reload schema';
COMMIT;
