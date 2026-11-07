BEGIN;
-- The cohort view's CASE inquiry date prevents a Page predicate on contacts from
-- bounding a hash scan of all ad sources. Bound both sides explicitly and reuse
-- the narrow Page base for leads, mature peers and missing-date coverage.
DO $migration$ DECLARE definition text;old_part text;BEGIN
 definition:=replace(pg_get_functiondef('veo_calendar_inputs(uuid,date,date,date,uuid)'::regprocedure),E'\r\n',E'\n');
 old_part:=$old$ WITH leads AS MATERIALIZED(SELECT$old$;
 IF strpos(definition,old_part)=0 THEN RAISE EXCEPTION 'Expected calendar lead query is missing';END IF;
 definition:=replace(definition,old_part,$new$ WITH cohort_base AS MATERIALIZED(
 SELECT c.id,c.page_id,c.name,c.psid,c.pipeline_stage,c.pipeline_stage_updated_at,
 CASE WHEN s.contact_id IS NOT NULL THEN s.first_inquiry_at ELSE c.first_interaction_at END AS first_inquiry_at,
 coalesce(s.inquiry_basis,'legacy_recorded') AS inquiry_basis,s.origin_ad_id AS ad_id,coalesce(s.attribution_status,'unknown') AS attribution_status
 FROM contacts c LEFT JOIN ad_contact_sources s ON s.contact_id=c.id AND s.page_id=c.page_id AND s.page_id=ANY(ids)
 WHERE c.page_id=ANY(ids)),
 leads AS MATERIALIZED(SELECT$new$);
 definition:=replace(definition,'FROM ad_lead_cohorts c','FROM cohort_base c');
 old_part:=$old$'missing_inquiry_dates',(SELECT count(*) FROM ad_lead_cohorts WHERE$old$;
 IF strpos(definition,old_part)=0 THEN RAISE EXCEPTION 'Expected calendar missing-date query is missing';END IF;
 definition:=replace(definition,old_part,$new$'missing_inquiry_dates',(SELECT count(*) FROM cohort_base WHERE$new$);
 old_part:=$old$IF (SELECT count(*) FROM ad_lead_cohorts WHERE page_id=ANY(ids) AND first_inquiry_at>=$old$;
 IF strpos(definition,old_part)=0 THEN RAISE EXCEPTION 'Expected calendar size guard is missing';END IF;
 definition:=replace(definition,old_part,$new$IF (SELECT count(*) FROM (
 SELECT CASE WHEN s.contact_id IS NOT NULL THEN s.first_inquiry_at ELSE c.first_interaction_at END AS first_inquiry_at
 FROM contacts c LEFT JOIN ad_contact_sources s ON s.contact_id=c.id AND s.page_id=c.page_id AND s.page_id=ANY(ids)
 WHERE c.page_id=ANY(ids)) bounded WHERE first_inquiry_at>=$new$);
 EXECUTE definition;
END $migration$;
NOTIFY pgrst,'reload schema';
COMMIT;
