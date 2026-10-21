BEGIN;

CREATE OR REPLACE FUNCTION public.chatbot_commercial_missing_details(p_details jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
    WITH fields(label,ordinal) AS (VALUES
        ('Business Name',1),('Page / Social Media Link',2),('Business Location',3),('Goal ng video',4),
        ('Preferred Video Length',5),('Preferred Style',6),('Contact Number',7),('Portrait or Landscape?',8)
    ), raw_answers AS (
        SELECT label,ordinal,CASE label
            WHEN 'Business Location' THEN COALESCE(p_details->'Business Location',p_details->'Location')
            WHEN 'Goal ng video' THEN COALESCE(p_details->'Goal ng video',p_details->'Goal ng Video')
            ELSE p_details->label END AS answer FROM fields
    ), answers AS (
        SELECT label,ordinal,answer,answer#>>'{}' AS value FROM raw_answers
    )
    SELECT COALESCE(jsonb_agg(label ORDER BY ordinal),'[]'::jsonb) FROM answers
    WHERE jsonb_typeof(answer) IS DISTINCT FROM 'string' OR value IS NULL OR NULLIF(btrim(value),'') IS NULL
        OR (btrim(value) ~* '^(unknown|not (provided|specified|stated|yet provided|yet specified)|n/?a|none|null|undefined|pending|tbd|to be (confirmed|determined)|not sure|unsure|hindi pa alam|wala( pa)?|[-?]+)[.!?[:space:]]*$'
            AND NOT (label='Page / Social Media Link' AND btrim(value) ~* '^(wala( pa)?|none|n/?a)[.!?[:space:]]*$'))
        OR (label='Contact Number' AND (length(regexp_replace(value,'[^0-9]','','g')) NOT BETWEEN 7 AND 15
            OR btrim(value) !~ '^[+0-9[:space:]().-]+$' OR regexp_replace(value,'[^0-9]','','g') ~ '^([0-9])\1+$'))
        OR (label='Preferred Video Length' AND CASE
            WHEN btrim(value) ~* '^[0-9]+(\.[0-9]+)?[[:space:]-]*(seconds?|secs?|s|segundos?|mins?|minutes?|minutos?)$'
            THEN (substring(value FROM '[0-9]+[.]?[0-9]*')::numeric * CASE WHEN value ~* 'min' THEN 60 ELSE 1 END) NOT BETWEEN 0.001 AND 600
            ELSE true END)
        OR (label='Portrait or Landscape?' AND btrim(value) !~* '^(portrait|landscape|vertical|horizontal|9[[:space:]]*:[[:space:]]*16|16[[:space:]]*:[[:space:]]*9)$');
$$;

ALTER TABLE public.chatbot_contact_states ALTER COLUMN form_version SET DEFAULT 2;

-- Change the form stamp while preserving the current request/hold/window guards.
DO $$
DECLARE definition text;
BEGIN
    SELECT pg_get_functiondef(p.oid) INTO definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='resume_chatbot_nightly_review';
    IF definition IS NULL THEN RAISE EXCEPTION 'Nightly intake review function is required'; END IF;
    EXECUTE regexp_replace(definition,'form_version[[:space:]]*=[[:space:]]*1','form_version=2','g');
END $$;

INSERT INTO app_private.schema_migrations(version,description) VALUES('20261021_002','Eight-field video form with duration preferences; preserve accepted-request stops')
ON CONFLICT(version) DO NOTHING;
COMMIT;
