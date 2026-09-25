-- Restore the one-default-tag invariant expected by the Messenger stage worker.
-- A previous data rollout marked Unqualified as a second default on each Page.

BEGIN;

ALTER TABLE public.tags
    ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

-- Page defaults are system-owned. Clear the invalid flags, then deterministically
-- restore the oldest Paid / Availed Service tag for every Page that has one.
UPDATE public.tags
SET is_default = FALSE
WHERE owner_type = 'page'
  AND is_default = TRUE;

WITH preferred AS (
    SELECT DISTINCT ON (tag.owner_id) tag.id
    FROM public.tags AS tag
    JOIN public.pages AS page ON page.id = tag.owner_id
    WHERE tag.owner_type = 'page'
      AND regexp_replace(lower(tag.name), '[^a-z]', '', 'g')
          IN ('paidavailedservice', 'paidavailedservices')
    ORDER BY tag.owner_id, tag.created_at NULLS LAST, tag.id
)
UPDATE public.tags
SET
    is_default = TRUE,
    page_id = owner_id
WHERE id IN (SELECT id FROM preferred);

INSERT INTO public.tags (name, color, owner_type, owner_id, page_id, is_default)
SELECT 'Paid / Availed Service', '#16a34a', 'page', page.id, page.id, TRUE
FROM public.pages AS page
WHERE NOT EXISTS (
    SELECT 1
    FROM public.tags AS tag
    WHERE tag.owner_type = 'page'
      AND tag.owner_id = page.id
      AND regexp_replace(lower(tag.name), '[^a-z]', '', 'g')
          IN ('paidavailedservice', 'paidavailedservices')
);

DROP INDEX IF EXISTS public.idx_tags_one_default_per_page;
CREATE UNIQUE INDEX idx_tags_one_default_per_page
    ON public.tags (owner_id)
    WHERE owner_type = 'page' AND is_default;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260925_002', 'Repair duplicate default Page tags and enforce one default per Page')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';

COMMIT;
