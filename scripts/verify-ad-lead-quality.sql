DO $$
DECLARE
    p UUID := gen_random_uuid(); c1 UUID := gen_random_uuid(); c2 UUID := gen_random_uuid(); c3 UUID := gen_random_uuid();
    report JSONB; origin TEXT; checks INTEGER := 0;
BEGIN
    INSERT INTO pages(id,fb_page_id,name,access_token) VALUES(p,'verification-'||p,'Ad Quality Verification','not-a-real-token');
    INSERT INTO contacts(id,page_id,psid,name) VALUES(c1,p,'verification-1','Ad Quality Fixture One'),(c2,p,'verification-2','Ad Quality Fixture Two'),(c3,p,'verification-3','Ad Quality Fixture Three');
    PERFORM record_standalone_ad_referral(p,'no-inquiry-yet','bare-referral','2026-10-20T00:00:00Z','{"ad_id":"123"}');
    ASSERT NOT EXISTS(SELECT 1 FROM contacts WHERE page_id=p AND psid='no-inquiry-yet'),'Bare referral created a CRM lead';
    ASSERT EXISTS(SELECT 1 FROM ad_referral_events WHERE event_key='bare-referral' AND contact_id IS NULL),'Bare referral evidence lost';
    checks:=checks+2;
    PERFORM record_contact_ad_event(p,c1,'open-1','2026-10-20T01:00:00Z','referral',false,NULL,'{"ad_id":"123","source":"ADS"}');
    ASSERT (SELECT first_inquiry_at IS NULL FROM ad_contact_sources WHERE contact_id=c1),'Thread-open counted as an inquiry';
    checks:=checks+1;
    PERFORM record_contact_ad_event(p,c1,'first-1','2026-10-20T01:01:00Z','message',true,'m-first','{"ad_id":"123","source":"ADS"}');
    PERFORM record_contact_ad_event(p,c1,'first-1','2026-10-20T01:01:00Z','message',true,'m-first','{"ad_id":"123","source":"ADS"}');
    ASSERT (SELECT origin_ad_id='123' FROM ad_contact_sources WHERE contact_id=c1),'Inline origin missing';
    ASSERT (SELECT count(*)=1 FROM ad_referral_events WHERE event_key='first-1'),'Duplicate referral stored twice'; checks:=checks+2;
    PERFORM record_contact_ad_event(p,c1,'later-1','2026-10-21T01:01:00Z','message',true,'m-later','{"ad_id":"456","source":"ADS"}');
    ASSERT (SELECT origin_ad_id='123' FROM ad_contact_sources WHERE contact_id=c1),'Later ad replaced acquisition'; checks:=checks+1;
    UPDATE contacts SET pipeline_stage='not_qualified',pipeline_stage_source='manual' WHERE id=c1;
    report:=get_ad_lead_quality(p,'2026-10-19T16:00:00Z','2026-10-20T16:00:00Z');
    ASSERT (report->>'inquiries')::int=1 AND (report->>'not_qualified')::int=1,'Later NQ must stay in original inquiry cohort'; checks:=checks+1;
    ASSERT (SELECT count(*)=1 FROM ad_lead_stage_events WHERE contact_id=c1 AND stage='not_qualified'),'Qualification transition not audited'; checks:=checks+1;
    ASSERT ((get_ad_lead_contacts(p,'2026-10-19T16:00:00Z','2026-10-20T16:00:00Z','123',false,'not_qualified')->>'total')::int)=1,'Drilldown differs from aggregate'; checks:=checks+1;
    PERFORM record_contact_ad_event(p,c2,'return-2','2026-10-20T01:01:00Z','message',true,'m-return','{"ad_id":"456"}','2026-09-01T00:00:00Z');
    ASSERT (SELECT origin_ad_id IS NULL AND first_inquiry_at='2026-09-01T00:00:00Z'::timestamptz FROM ad_contact_sources WHERE contact_id=c2),'Returning legacy contact was counted as a new acquisition'; checks:=checks+1;
    PERFORM record_contact_ad_event(p,c3,'later-first','2026-10-21T01:01:00Z','message',true,'m-new','{"ad_id":"456"}');
    PERFORM record_contact_ad_event(p,c3,'delayed-earlier','2026-10-19T01:01:00Z','message',true,'m-old','{}');
    ASSERT (SELECT origin_ad_id IS NULL AND first_inquiry_at='2026-10-19T01:01:00Z'::timestamptz FROM ad_contact_sources WHERE contact_id=c3),'Delayed earlier inquiry did not clear wrong attribution'; checks:=checks+1;
    PERFORM record_contact_ad_event(p,c1,'conflict','2026-10-20T01:01:00Z','message',true,'m-first','{"ad_id":"789"}');
    ASSERT (SELECT origin_ad_id IS NULL AND attribution_status='conflicting_sources' FROM ad_contact_sources WHERE contact_id=c1),'Conflicting origin was not quarantined'; checks:=checks+1;
    ASSERT NOT has_function_privilege('authenticated','public.get_ad_lead_quality(uuid,timestamptz,timestamptz)','EXECUTE'),'Authenticated role can bypass Page authorization';
    ASSERT NOT has_table_privilege('anon','public.ad_lead_cohorts','SELECT'),'Anonymous data access'; checks:=checks+2;
    RAISE NOTICE 'Ad quality SQL verification passed: % checks; all fixtures roll back', checks;
END $$;
