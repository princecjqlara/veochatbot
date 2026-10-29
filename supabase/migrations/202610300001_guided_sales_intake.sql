-- Additive settings only. Existing handoff, state, schedules and triggers stay intact.
ALTER TABLE public.chatbot_configs
    ADD COLUMN IF NOT EXISTS guided_sales_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS sales_form_fields text[] NOT NULL DEFAULT ARRAY[
        'Business Name', 'Business Industry', 'Product / Service', 'Preferred Style', 'Goal ng video', 'Additional Requests'
    ]::text[];
