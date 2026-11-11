BEGIN;
SET LOCAL lock_timeout='5s';
-- Evidence is identified by its slot and uploaded record. A single screenshot
-- can legitimately show both the lead stage and the order, so identical image
-- contents in separate slots must not reject an otherwise complete submission.
DO $$ DECLARE definition text;needle text:=$old$ OR(SELECT count(DISTINCT photo_sha256) FROM veo_deal_review_photos WHERE id=ANY(p_photos))<>3$old$;BEGIN
 definition:=pg_get_functiondef('veo_submit_deal_review_before_supervisor(uuid,jsonb,uuid[])'::regprocedure);
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Expected the three-image content restriction';END IF;
 EXECUTE replace(definition,needle,'');
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
