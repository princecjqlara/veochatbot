BEGIN;
-- Page, branch and date selectivity vary widely between requests sharing a
-- PostgREST connection. A reused generic plan makes the busiest Page exceed the
-- API's statement timeout even though its parameter-specific plan fits easily.
ALTER FUNCTION veo_calendar_inputs(uuid,date,date,date,uuid) SET plan_cache_mode='force_custom_plan';
ALTER FUNCTION veo_employee_profile(uuid,uuid,date,date,uuid) SET plan_cache_mode='force_custom_plan';
NOTIFY pgrst,'reload schema';
COMMIT;
