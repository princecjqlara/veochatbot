-- Preserve Messenger / Business Suite lead outcomes as cumulative contact tags.
-- The pipeline still stores the contact's current stage, while these tags retain
-- every outcome observed in the conversation history.

BEGIN;

ALTER TABLE public.tags
    ADD COLUMN IF NOT EXISTS system_key TEXT;

-- Reuse an existing Page tag with the same exact outcome name when possible so
-- the rollout does not create a visually duplicated tag.
WITH outcome_names(system_key, name) AS (
    VALUES
        ('qualified', 'Qualified'),
        ('not_qualified', 'Not Qualified'),
        ('converted', 'Converted'),
        ('order_created', 'Order Created')
), candidates AS (
    SELECT DISTINCT ON (tag.owner_id, outcome.system_key)
        tag.id,
        outcome.system_key
    FROM public.tags AS tag
    JOIN public.pages AS page ON page.id = tag.owner_id
    JOIN outcome_names AS outcome ON lower(btrim(tag.name)) = lower(outcome.name)
    WHERE tag.owner_type = 'page'
      AND tag.system_key IS NULL
      AND tag.is_default = FALSE
    ORDER BY tag.owner_id, outcome.system_key, tag.created_at NULLS LAST, tag.id
)
UPDATE public.tags AS tag
SET
    system_key = candidates.system_key,
    page_id = tag.owner_id
FROM candidates
WHERE tag.id = candidates.id;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'tags_system_key_check'
          AND conrelid = 'public.tags'::regclass
    ) THEN
        ALTER TABLE public.tags
            ADD CONSTRAINT tags_system_key_check
            CHECK (
                system_key IS NULL OR (
                    owner_type = 'page'
                    AND page_id = owner_id
                    AND system_key IN ('qualified', 'not_qualified', 'converted', 'order_created')
                )
            );
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_page_system_key
    ON public.tags (owner_id, system_key);

INSERT INTO public.tags (name, color, owner_type, owner_id, page_id, is_default, system_key)
SELECT outcome.name, outcome.color, 'page', page.id, page.id, FALSE, outcome.system_key
FROM public.pages AS page
CROSS JOIN (
    VALUES
        ('qualified', 'Qualified', '#2563eb'),
        ('not_qualified', 'Not Qualified', '#dc2626'),
        ('converted', 'Converted', '#7c3aed'),
        ('order_created', 'Order Created', '#f59e0b')
) AS outcome(system_key, name, color)
ON CONFLICT (owner_id, system_key) DO UPDATE
SET
    name = EXCLUDED.name,
    color = EXCLUDED.color,
    owner_type = 'page',
    page_id = EXCLUDED.page_id,
    is_default = FALSE;

CREATE OR REPLACE FUNCTION public.create_default_page_tags()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO public.tags (name, color, owner_type, owner_id, page_id, is_default)
    VALUES ('Paid / Availed Service', '#16a34a', 'page', NEW.id, NEW.id, TRUE);

    INSERT INTO public.tags (name, color, owner_type, owner_id, page_id, is_default, system_key)
    VALUES
        ('Qualified', '#2563eb', 'page', NEW.id, NEW.id, FALSE, 'qualified'),
        ('Not Qualified', '#dc2626', 'page', NEW.id, NEW.id, FALSE, 'not_qualified'),
        ('Converted', '#7c3aed', 'page', NEW.id, NEW.id, FALSE, 'converted'),
        ('Order Created', '#f59e0b', 'page', NEW.id, NEW.id, FALSE, 'order_created');

    RETURN NEW;
END;
$$;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260925_003', 'Add cumulative Messenger outcome tags for every Page')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';

COMMIT;
