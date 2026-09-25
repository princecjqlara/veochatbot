-- VeoBot complete baseline schema.
-- Generated from the maintained schema plus the latest operational migrations.
-- Applied projects use migration history; new projects receive the entire schema
-- before feature-specific migrations are applied.

-- >>> SOURCE: database/schema.sql
    -- VeoBot Database Schema
    -- Run this SQL in your Supabase SQL Editor

    -- Enable UUID extension
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    -- Users table
    CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        email TEXT UNIQUE, -- Can be NULL for Facebook users without emails
        name TEXT,
        image TEXT,
        facebook_id TEXT,
        password_hash TEXT,
        role TEXT DEFAULT 'user',
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Businesses table (for multi-user/business support)
    CREATE TABLE IF NOT EXISTS businesses (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Business users table (linking users to businesses)
    CREATE TABLE IF NOT EXISTS business_users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(business_id, user_id)
    );

    -- Pages table (Facebook pages)
    CREATE TABLE IF NOT EXISTS pages (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        fb_page_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        access_token TEXT NOT NULL,
        business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
        last_synced_at TIMESTAMPTZ, -- Timestamp of last successful sync (for incremental syncing)
        messaging_auto_tag_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        messaging_auto_tag_checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        messaging_auto_tag_cursor TEXT,
        messaging_auto_tag_attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        messaging_auto_tag_last_error TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- User pages table (linking users to pages)
    CREATE TABLE IF NOT EXISTS user_pages (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, page_id)
    );

    -- Contacts table (Facebook page contacts/conversations)
    CREATE TABLE IF NOT EXISTS contacts (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        psid TEXT NOT NULL,
        name TEXT,
        profile_pic TEXT,
        last_interaction_at TIMESTAMPTZ,
        best_contact_hour INTEGER,
        best_contact_confidence TEXT DEFAULT 'none',
        best_contact_hours JSONB DEFAULT '[]'::jsonb,
        interaction_count INTEGER DEFAULT 0,
        first_interaction_at TIMESTAMPTZ,
        last_inbound_at TIMESTAMPTZ,
        pipeline_stage TEXT NOT NULL DEFAULT 'new' CHECK (pipeline_stage IN ('new', 'engaged', 'collecting_details', 'qualified', 'order_created', 'converted', 'not_qualified', 'opted_out')),
        pipeline_stage_source TEXT NOT NULL DEFAULT 'system' CHECK (pipeline_stage_source IN ('system', 'chatbot', 'messenger', 'manual')),
        pipeline_stage_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT contacts_name_not_placeholder CHECK (
            name IS NULL
            OR (
                btrim(name) <> ''
                AND lower(btrim(name)) NOT IN ('unknown', 'unknown name', 'unknown user', 'facebook user', 'messenger contact', 'undefined', 'null')
            )
        ),
        UNIQUE(page_id, psid)
    );

    -- Tags table
    CREATE TABLE IF NOT EXISTS tags (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name TEXT NOT NULL,
        color TEXT DEFAULT '#3B82F6',
        owner_type TEXT NOT NULL DEFAULT 'user', -- 'user', 'page', 'business'
        owner_id UUID NOT NULL, -- References user_id, page_id, or business_id based on owner_type
        page_id UUID REFERENCES pages(id) ON DELETE CASCADE,
        is_shared BOOLEAN NOT NULL DEFAULT FALSE,
        is_default BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Contact tags table (many-to-many relationship)
    CREATE TABLE IF NOT EXISTS tag_shares (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        shared_with_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(tag_id, shared_with_user_id)
    );

    -- Contact tags table (many-to-many relationship)
    CREATE TABLE IF NOT EXISTS contact_tags (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(contact_id, tag_id)
    );

    -- Campaigns table
    CREATE TABLE IF NOT EXISTS campaigns (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        message_text TEXT,
        status TEXT NOT NULL DEFAULT 'draft', -- 'draft', 'scheduled', 'sending', 'completed', 'cancelled'
        scheduled_at TIMESTAMPTZ,
        audience_mode TEXT DEFAULT 'specific', -- 'specific' or 'dynamic'
        audience_start_date DATE,
        audience_include_tag_ids JSONB DEFAULT '[]',
        audience_exclude_tag_ids JSONB DEFAULT '[]',
        audience_materialized_at TIMESTAMPTZ,
        template_media_header JSONB,
        template_media_headers JSONB,
        next_attempt_at TIMESTAMPTZ,
        last_error TEXT,
        background_delivery_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        is_loop BOOLEAN DEFAULT FALSE,
        ai_prompt TEXT,
        loop_status TEXT DEFAULT 'stopped',
        last_run_at TIMESTAMPTZ,
        use_ai_message BOOLEAN DEFAULT FALSE,
        scheduled_date TIMESTAMPTZ,
        use_best_time BOOLEAN DEFAULT FALSE,
        template_name TEXT,
        template_language TEXT,
        recurrence TEXT DEFAULT 'none',
        recurrence_end_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        recipient_history_purged_at TIMESTAMPTZ,
        total_recipients INTEGER DEFAULT 0,
        sent_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Campaign recipients table (tracks which contacts receive which campaigns)
    CREATE TABLE IF NOT EXISTS campaign_recipients (
        campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'sent', 'failed'
        scheduled_at TIMESTAMPTZ,
        next_scheduled_at TIMESTAMPTZ,
        sent_at TIMESTAMPTZ,
        error_message TEXT,
        claim_token UUID,
        claimed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        message_sent_count INTEGER DEFAULT 0,
        last_contacted_at TIMESTAMPTZ,
        PRIMARY KEY(campaign_id, contact_id)
    );

    -- Only failures need recipient-level history. Successful one-time delivery
    -- rows are deleted immediately after campaign counters are incremented.
    CREATE TABLE IF NOT EXISTS campaign_delivery_failures (
        campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        error_message TEXT NOT NULL,
        failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        attempt_count SMALLINT NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
        PRIMARY KEY(campaign_id, contact_id)
    );

    -- Shared page audit history for bulk actions outside campaign sending
    CREATE TABLE IF NOT EXISTS page_activity_history (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        action_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id UUID,
        status TEXT NOT NULL DEFAULT 'completed',
        summary TEXT NOT NULL,
        target_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT page_activity_history_status_check
            CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed', 'cancelled')),
        CONSTRAINT page_activity_history_counts_check
            CHECK (target_count >= 0 AND success_count >= 0 AND failure_count >= 0)
    );

    CREATE INDEX IF NOT EXISTS idx_page_activity_history_page_created
        ON page_activity_history(page_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_page_activity_history_actor
        ON page_activity_history(actor_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_page_activity_history_action
        ON page_activity_history(action_type, created_at DESC);

    -- Durable conversation export queue. Export chunks are kept in the private
    -- `conversation-exports` Storage bucket and expire after seven days.
    CREATE TABLE IF NOT EXISTS conversation_export_jobs (
        id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
        page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        format TEXT NOT NULL DEFAULT 'csv' CHECK (format IN ('csv')),
        scope TEXT NOT NULL CHECK (scope IN ('all', 'selected')),
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        contact_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        next_contact_index INTEGER NOT NULL DEFAULT 0 CHECK (next_contact_index >= 0),
        next_cursor TEXT,
        total_items INTEGER CHECK (total_items IS NULL OR total_items >= 0),
        processed_items INTEGER NOT NULL DEFAULT 0 CHECK (processed_items >= 0),
        conversation_count INTEGER NOT NULL DEFAULT 0 CHECK (conversation_count >= 0),
        message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
        chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
        filename TEXT NOT NULL,
        storage_prefix TEXT NOT NULL,
        error_message TEXT,
        attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at TIMESTAMPTZ,
        claim_token UUID,
        claimed_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_export_jobs_worker
        ON conversation_export_jobs(status, next_attempt_at, claimed_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_conversation_export_jobs_user_created
        ON conversation_export_jobs(created_by, created_at DESC);

    -- Workflow automations table (multi-step follow-up messages)
    CREATE TABLE IF NOT EXISTS workflow_automations (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        trigger_type TEXT NOT NULL DEFAULT 'follow_up',
        message_text TEXT NOT NULL,
        stop_keywords JSONB NOT NULL DEFAULT '[]',
        steps JSONB NOT NULL DEFAULT '[]',
        reply_action TEXT NOT NULL DEFAULT 'reset',
        page_stop_code TEXT,
        cooldown_minutes INTEGER NOT NULL DEFAULT 60,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT workflow_automations_trigger_type_check CHECK (trigger_type IN ('contact_reply', 'follow_up')),
        CONSTRAINT workflow_automations_reply_action_check CHECK (reply_action IN ('stop', 'reset', 'continue')),
        CONSTRAINT workflow_automations_cooldown_minutes_check CHECK (cooldown_minutes >= 0 AND cooldown_minutes <= 10080)
    );

    -- Workflow automation states table (per-contact progress and send history)
    CREATE TABLE IF NOT EXISTS workflow_automation_states (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        automation_id UUID NOT NULL REFERENCES workflow_automations(id) ON DELETE CASCADE,
        contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'active',
        current_step_index INTEGER NOT NULL DEFAULT 0,
        next_step_at TIMESTAMPTZ,
        stopped_at TIMESTAMPTZ,
        stopped_reason TEXT,
        last_triggered_at TIMESTAMPTZ,
        last_sent_at TIMESTAMPTZ,
        last_contact_reply_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(automation_id, contact_id),
        CONSTRAINT workflow_automation_states_status_check CHECK (status IN ('active', 'stopped', 'completed'))
    );

    -- Per-page inbound Messenger chatbot configuration.
    CREATE TABLE IF NOT EXISTS chatbot_configs (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        page_id UUID NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        trial_mode_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        trial_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
        instructions TEXT NOT NULL DEFAULT 'You are a helpful customer support assistant for this Facebook Page. Be concise, friendly, accurate, and never invent prices, policies, availability, or promises.',
        fallback_reply TEXT NOT NULL DEFAULT 'Thanks for your message! A member of our team will get back to you shortly.',
        model TEXT NOT NULL DEFAULT '~deepseek/deepseek-flash-latest',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Idempotency and delivery status for automatic chatbot replies.
    CREATE TABLE IF NOT EXISTS chatbot_reply_events (
        inbound_message_id TEXT PRIMARY KEY,
        page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
        outbound_message_id TEXT,
        status TEXT NOT NULL DEFAULT 'processing',
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chatbot_reply_events_status_check CHECK (status IN ('processing', 'sent', 'failed'))
    );

    -- Per-page welcome message sent when a new Messenger contact appears.
    CREATE TABLE IF NOT EXISTS welcome_messages (
        id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
        page_id UUID NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,
        enabled BOOLEAN DEFAULT FALSE,
        message_text TEXT NOT NULL DEFAULT '',
        buttons JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Exact source attribution for outbound messages in conversation exports.
    CREATE TABLE IF NOT EXISTS outbound_message_events (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
        message_id TEXT NOT NULL UNIQUE,
        source_type TEXT NOT NULL,
        source_id UUID,
        source_name TEXT,
        actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        actor_name TEXT,
        message_kind TEXT,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT outbound_message_events_source_type_check
            CHECK (source_type IN ('manual', 'campaign', 'automation', 'welcome', 'chatbot'))
    );

    -- Indexes for better query performance
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_facebook_id ON users(facebook_id);
    CREATE INDEX IF NOT EXISTS idx_pages_fb_page_id ON pages(fb_page_id);
    CREATE INDEX IF NOT EXISTS idx_user_pages_user_id ON user_pages(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_pages_page_id ON user_pages(page_id);
    -- UNIQUE (page_id, psid) already provides the contact lookup index.
    CREATE INDEX IF NOT EXISTS idx_contact_tags_contact_id ON contact_tags(contact_id);
    CREATE INDEX IF NOT EXISTS idx_contact_tags_tag_id ON contact_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_contact_tags_created_by ON contact_tags(created_by);
    CREATE INDEX IF NOT EXISTS idx_outbound_message_events_page_message ON outbound_message_events(page_id, message_id);
    CREATE INDEX IF NOT EXISTS idx_outbound_message_events_page_sent ON outbound_message_events(page_id, sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tags_owner_type ON tags(owner_type);
    CREATE INDEX IF NOT EXISTS idx_tags_owner_id ON tags(owner_id);
    CREATE INDEX IF NOT EXISTS idx_tags_page_id ON tags(page_id);
    CREATE INDEX IF NOT EXISTS idx_tags_is_shared ON tags(is_shared);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_one_default_per_page ON tags (owner_id)
        WHERE owner_type = 'page' AND is_default;
    CREATE INDEX IF NOT EXISTS idx_tag_shares_tag_id ON tag_shares(tag_id);
    CREATE INDEX IF NOT EXISTS idx_tag_shares_shared_with_user_id ON tag_shares(shared_with_user_id);
    CREATE INDEX IF NOT EXISTS idx_campaigns_page_id ON campaigns(page_id);
    CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
    CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled_at ON campaigns(scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_campaigns_immediate_sending ON campaigns(next_attempt_at, updated_at, id)
        WHERE status = 'sending' AND scheduled_at IS NULL AND background_delivery_enabled AND NOT COALESCE(is_loop, FALSE);
    -- UNIQUE (campaign_id, contact_id) already indexes campaign_id.
    CREATE INDEX IF NOT EXISTS idx_campaign_recipients_contact_id ON campaign_recipients(contact_id);
    CREATE INDEX IF NOT EXISTS idx_campaign_delivery_failures_campaign_failed ON campaign_delivery_failures(campaign_id, failed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_automations_page_enabled ON workflow_automations(page_id, enabled, trigger_type);
    CREATE INDEX IF NOT EXISTS idx_workflow_automation_states_contact ON workflow_automation_states(contact_id, status);
    CREATE INDEX IF NOT EXISTS idx_workflow_automation_states_automation ON workflow_automation_states(automation_id, status);
    CREATE INDEX IF NOT EXISTS idx_workflow_automation_states_due ON workflow_automation_states(next_step_at, status) WHERE next_step_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_chatbot_reply_events_page_created ON chatbot_reply_events(page_id, created_at DESC);

    -- Function to update updated_at timestamp
    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
    END;
    $$ language 'plpgsql';

    -- Triggers to automatically update updated_at
    CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    CREATE TRIGGER update_pages_updated_at BEFORE UPDATE ON pages
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    CREATE TRIGGER update_contacts_updated_at BEFORE UPDATE ON contacts
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    CREATE TRIGGER update_tags_updated_at BEFORE UPDATE ON tags
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    CREATE OR REPLACE FUNCTION create_default_page_tags()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
    BEGIN
        INSERT INTO tags (name, color, owner_type, owner_id, page_id, is_default)
        VALUES ('Paid / Availed Service', '#16a34a', 'page', NEW.id, NEW.id, TRUE);
        RETURN NEW;
    END;
    $$;

    CREATE TRIGGER create_default_page_tags_on_insert AFTER INSERT ON pages
        FOR EACH ROW EXECUTE FUNCTION create_default_page_tags();

    CREATE TRIGGER update_campaigns_updated_at BEFORE UPDATE ON campaigns
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    CREATE TRIGGER update_workflow_automations_updated_at BEFORE UPDATE ON workflow_automations
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    CREATE TRIGGER update_workflow_automation_states_updated_at BEFORE UPDATE ON workflow_automation_states
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    CREATE TRIGGER update_chatbot_configs_updated_at BEFORE UPDATE ON chatbot_configs
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    CREATE TRIGGER update_conversation_export_jobs_updated_at BEFORE UPDATE ON conversation_export_jobs
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    CREATE OR REPLACE FUNCTION claim_conversation_export_job(p_job_id UUID DEFAULT NULL)
    RETURNS SETOF conversation_export_jobs
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
    DECLARE
        v_job_id UUID;
    BEGIN
        SELECT job.id INTO v_job_id
        FROM conversation_export_jobs AS job
        WHERE (p_job_id IS NULL OR job.id = p_job_id)
          AND job.expires_at > NOW()
          AND (
              job.status = 'queued'
              OR (job.status = 'running' AND (job.claimed_at IS NULL OR job.claimed_at < NOW() - INTERVAL '6 minutes'))
          )
          AND (job.next_attempt_at IS NULL OR job.next_attempt_at <= NOW())
        ORDER BY job.created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED;

        IF v_job_id IS NULL THEN RETURN; END IF;

        RETURN QUERY
        UPDATE conversation_export_jobs AS claimed
        SET status = 'running', claim_token = pg_catalog.gen_random_uuid(), claimed_at = NOW(),
            started_at = COALESCE(started_at, NOW()), error_message = NULL, updated_at = NOW()
        WHERE claimed.id = v_job_id
        RETURNING claimed.*;
    END;
    $$;

    REVOKE ALL ON FUNCTION claim_conversation_export_job(UUID) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION claim_conversation_export_job(UUID) TO service_role;

    -- Row Level Security (RLS) Policies
    -- Enable RLS on all tables
    ALTER TABLE users ENABLE ROW LEVEL SECURITY;
    ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
    ALTER TABLE business_users ENABLE ROW LEVEL SECURITY;
    ALTER TABLE pages ENABLE ROW LEVEL SECURITY;
    ALTER TABLE user_pages ENABLE ROW LEVEL SECURITY;
    ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tag_shares ENABLE ROW LEVEL SECURITY;
    ALTER TABLE contact_tags ENABLE ROW LEVEL SECURITY;
    ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
    ALTER TABLE campaign_recipients ENABLE ROW LEVEL SECURITY;
    ALTER TABLE conversation_export_jobs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE campaign_delivery_failures ENABLE ROW LEVEL SECURITY;
    ALTER TABLE workflow_automations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE workflow_automation_states ENABLE ROW LEVEL SECURITY;
    ALTER TABLE chatbot_configs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE chatbot_reply_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE outbound_message_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE welcome_messages ENABLE ROW LEVEL SECURITY;

    -- Note: Since we're using service role key in the API routes,
    -- RLS policies are bypassed. But we can add policies for future use:
    -- Example policy for users (users can only see their own data):
    -- CREATE POLICY "Users can view own data" ON users
    --     FOR SELECT USING (auth.uid()::text = id::text);

    -- Grant necessary permissions (adjust based on your setup)
    -- The service role key bypasses RLS, so these are mainly for reference
    GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, anon, authenticated;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, anon, authenticated;



-- <<< END SOURCE: database/schema.sql

-- >>> SOURCE: database/migration_add_last_synced_at.sql
-- Migration: Add last_synced_at to pages table for incremental syncing
-- Run this in your Supabase SQL Editor

ALTER TABLE pages
ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pages_last_synced_at ON pages(last_synced_at);

UPDATE pages
SET last_synced_at = created_at
WHERE last_synced_at IS NULL;


-- <<< END SOURCE: database/migration_add_last_synced_at.sql

-- >>> SOURCE: database/migration_complete.sql
-- Complete Migration: Add all missing columns to campaigns table
-- Run this in Supabase SQL Editor

-- Core campaign scheduling columns
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS scheduled_date TIMESTAMPTZ;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS use_best_time BOOLEAN DEFAULT FALSE;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience_mode TEXT DEFAULT 'specific';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience_start_date DATE;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience_include_tag_ids JSONB DEFAULT '[]';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience_exclude_tag_ids JSONB DEFAULT '[]';

-- Loop campaign columns
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS is_loop BOOLEAN DEFAULT FALSE;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ai_prompt TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS loop_status TEXT DEFAULT 'stopped';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ;

-- AI personalized messages for non-loop campaigns
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS use_ai_message BOOLEAN DEFAULT FALSE;

-- Daily-recurring scheduled campaigns
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS recurrence TEXT DEFAULT 'none';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS recurrence_end_at TIMESTAMPTZ;

-- Campaign recipients additional columns
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS next_scheduled_at TIMESTAMPTZ;
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS message_sent_count INTEGER DEFAULT 0;
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMPTZ;

-- Contacts best time columns
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS best_contact_hours JSONB DEFAULT '[]';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS interaction_count INTEGER DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS best_contact_hour INTEGER;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS best_contact_confidence TEXT DEFAULT 'none';


-- <<< END SOURCE: database/migration_complete.sql

-- >>> SOURCE: database/migration_campaign_loops.sql
-- Campaign Loops Migration
-- Run this SQL in your Supabase SQL Editor

-- Add loop campaign columns to campaigns table
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS is_loop BOOLEAN DEFAULT FALSE;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ai_prompt TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS loop_status TEXT DEFAULT 'stopped'; -- 'active', 'paused', 'stopped'
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ;

-- Index for efficient cron queries (find active loop campaigns)
CREATE INDEX IF NOT EXISTS idx_campaigns_loop_active
ON campaigns(is_loop, loop_status) WHERE is_loop = TRUE;

-- Add next_scheduled_at to campaign_recipients for loop rescheduling
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS next_scheduled_at TIMESTAMPTZ;

-- Add message_sent_count to track how many times a recipient received a loop message
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS message_sent_count INTEGER DEFAULT 0;

-- Add last_contacted_at to track when recipient was last contacted in loop
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMPTZ;

-- Index for finding due recipients in loop campaigns
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_next_scheduled
ON campaign_recipients(next_scheduled_at, status) WHERE next_scheduled_at IS NOT NULL;

-- Add check constraint for loop_status values
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'campaigns_loop_status_check'
    ) THEN
        ALTER TABLE campaigns ADD CONSTRAINT campaigns_loop_status_check
        CHECK (loop_status IN ('active', 'paused', 'stopped'));
    END IF;
END $$;


-- <<< END SOURCE: database/migration_campaign_loops.sql

-- >>> SOURCE: database/migration_scheduled_campaigns.sql
-- Best Time Campaign Scheduling Migration
-- Run this SQL in your Supabase SQL Editor

-- Add scheduled_at to campaign_recipients for per-contact scheduling
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;

-- Index for efficient cron queries (find due scheduled messages)
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_scheduled
ON campaign_recipients(scheduled_at, status) WHERE scheduled_at IS NOT NULL;

-- Add use_best_time flag to campaigns
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS use_best_time BOOLEAN DEFAULT FALSE;

-- Add scheduled_date to campaigns (the date user selected for sending)
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS scheduled_date DATE;


-- <<< END SOURCE: database/migration_scheduled_campaigns.sql

-- >>> SOURCE: database/migration_campaign_scheduled_audience.sql
-- Scheduled campaign audience rules migration
-- Run this in Supabase SQL Editor

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience_mode TEXT DEFAULT 'specific';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience_start_date DATE;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience_include_tag_ids JSONB DEFAULT '[]';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience_exclude_tag_ids JSONB DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled_at
ON campaigns(scheduled_at, status)
WHERE scheduled_at IS NOT NULL;


-- <<< END SOURCE: database/migration_campaign_scheduled_audience.sql

-- >>> SOURCE: database/migration_template_columns.sql
-- Migration: Add template_name and template_language columns to campaigns table
-- These columns store the WhatsApp/Facebook approved template details for non-AI campaigns

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS template_name TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS template_language TEXT;

-- Documentation
COMMENT ON COLUMN campaigns.template_name IS 'Name of the approved message template to use (e.g. WhatsApp Business template). NULL for AI or loop campaigns.';
COMMENT ON COLUMN campaigns.template_language IS 'Language code for the message template (e.g. en_US). Defaults to en_US when template_name is set.';


-- <<< END SOURCE: database/migration_template_columns.sql

-- >>> SOURCE: database/migration_messaging_auto_tag.sql
-- Auto-tag Messenger contacts when Meta records an order or a qualified/converted lead stage.
-- Start at deployment time: historical orders are not silently backfilled.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS messaging_auto_tag_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS messaging_auto_tag_checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE pages ADD COLUMN IF NOT EXISTS messaging_auto_tag_cursor TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS messaging_auto_tag_attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE pages ADD COLUMN IF NOT EXISTS messaging_auto_tag_last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_pages_messaging_auto_tag_due
ON pages (messaging_auto_tag_attempted_at)
WHERE messaging_auto_tag_enabled;


-- <<< END SOURCE: database/migration_messaging_auto_tag.sql

-- >>> SOURCE: database/migration_human_agent_last_inbound.sql
-- Track the customer's last actual message separately from conversation activity.
-- Conversation updated_time also advances when the Page sends a message and must
-- never be used to determine the Messenger Human Agent window.
ALTER TABLE public.contacts
ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_contacts_page_last_inbound
ON public.contacts (page_id, last_inbound_at DESC)
WHERE last_inbound_at IS NOT NULL;

-- Webhooks and full syncs can overlap. Never let an older sync result move the
-- customer's last-message clock backwards.
CREATE OR REPLACE FUNCTION public.preserve_contact_last_inbound_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.last_inbound_at IS NOT NULL THEN
        NEW.last_inbound_at := GREATEST(OLD.last_inbound_at, NEW.last_inbound_at);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS preserve_contact_last_inbound_at ON public.contacts;
CREATE TRIGGER preserve_contact_last_inbound_at
BEFORE UPDATE ON public.contacts
FOR EACH ROW EXECUTE FUNCTION public.preserve_contact_last_inbound_at();

-- Backfill recent inbound events so existing contacts can appear immediately.
-- Older history is irrelevant to the current seven-day window.
DO $$
BEGIN
    IF to_regclass('app_private.contact_interaction_hourly_stats') IS NOT NULL THEN
        UPDATE public.contacts AS c
        SET last_inbound_at = recent.last_inbound_at
        FROM (
            SELECT contact_id, MAX(last_interaction_at) AS last_inbound_at
            FROM app_private.contact_interaction_hourly_stats
            WHERE is_from_contact = TRUE
              AND last_interaction_at >= NOW() - INTERVAL '7 days'
            GROUP BY contact_id
        ) AS recent
        WHERE c.id = recent.contact_id
          AND (c.last_inbound_at IS NULL OR c.last_inbound_at < recent.last_inbound_at);
    ELSIF to_regclass('public.contact_interactions') IS NOT NULL THEN
        UPDATE public.contacts AS c
        SET last_inbound_at = recent.last_inbound_at
        FROM (
            SELECT contact_id, MAX(interaction_at) AS last_inbound_at
            FROM public.contact_interactions
            WHERE is_from_contact = TRUE
              AND interaction_at >= NOW() - INTERVAL '7 days'
            GROUP BY contact_id
        ) AS recent
        WHERE c.id = recent.contact_id
          AND (c.last_inbound_at IS NULL OR c.last_inbound_at < recent.last_inbound_at);
    END IF;
END $$;


-- <<< END SOURCE: database/migration_human_agent_last_inbound.sql

-- >>> SOURCE: database/migration_best_time_to_contact.sql
-- Best Time to Contact Feature Migration
-- Run this SQL in your Supabase SQL Editor

-- contact_interactions table to track individual message timestamps
CREATE TABLE IF NOT EXISTS contact_interactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    interaction_at TIMESTAMPTZ NOT NULL,
    hour_of_day INTEGER NOT NULL, -- 0-23 (for quick aggregation)
    day_of_week INTEGER NOT NULL, -- 0-6 (Sunday = 0)
    is_from_contact BOOLEAN DEFAULT TRUE, -- true if message from contact, false if from page
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_contact_interactions_contact_id ON contact_interactions(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_interactions_page_id ON contact_interactions(page_id);
CREATE INDEX IF NOT EXISTS idx_contact_interactions_hour ON contact_interactions(hour_of_day);
CREATE INDEX IF NOT EXISTS idx_contact_interactions_day ON contact_interactions(day_of_week);
CREATE INDEX IF NOT EXISTS idx_contact_interactions_interaction_at ON contact_interactions(interaction_at);

-- Add best_time_to_contact fields to contacts table
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS best_contact_hour INTEGER; -- 0-23
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS best_contact_confidence TEXT DEFAULT 'none'; -- 'high', 'medium', 'low', 'inferred', 'none'

-- Enable RLS on contact_interactions
ALTER TABLE contact_interactions ENABLE ROW LEVEL SECURITY;

-- Grant permissions
GRANT ALL ON contact_interactions TO postgres, anon, authenticated;


-- <<< END SOURCE: database/migration_best_time_to_contact.sql

-- >>> SOURCE: database/migration_best_time_enhanced.sql
-- Migration: Enhanced Best Time to Contact with Multiple Hours
-- Run this in Supabase SQL Editor

-- Add column for multiple best hours (JSON array of {hour: number, count: number})
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS best_contact_hours JSONB DEFAULT '[]';

-- Add column for total interaction count analyzed
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS interaction_count INTEGER DEFAULT 0;

-- Ensure single best hour columns exist for backwards compatibility
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS best_contact_hour INTEGER;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS best_contact_confidence TEXT DEFAULT 'none';

-- Example of what best_contact_hours will look like:
-- [{"hour": 10, "count": 15}, {"hour": 14, "count": 8}, {"hour": 19, "count": 5}]
-- This shows the contact is most active at 10am (15 messages), 2pm (8 messages), and 7pm (5 messages)


-- <<< END SOURCE: database/migration_best_time_enhanced.sql

-- >>> SOURCE: database/migration_database_retention.sql
-- Keep the Supabase Free Plan database below its size quota.
--
-- Campaign-level totals remain in `campaigns`. Only recipient-level delivery
-- detail is removed after a terminal campaign has been finished for one day.
-- Draft, scheduled, sending, and looping campaigns are never touched.

ALTER TABLE campaigns
ADD COLUMN IF NOT EXISTS recipient_history_purged_at TIMESTAMPTZ;

-- These indexes duplicate indexes that PostgreSQL already maintains for the
-- UNIQUE constraints. Removing them reduces both storage and write overhead.
DROP INDEX IF EXISTS idx_campaign_recipients_campaign_id;
DROP INDEX IF EXISTS idx_contacts_page_psid;

-- These contact indexes are covered by the leading columns of the UNIQUE
-- (page_id, psid) index used by every PSID lookup in the application.
DROP INDEX IF EXISTS idx_contacts_page_id;
DROP INDEX IF EXISTS idx_contacts_psid;

-- Run one bounded batch at a time so scheduled maintenance does not hold a
-- large delete transaction open. Repeated calls drain any backlog.
CREATE OR REPLACE FUNCTION public.cleanup_terminal_campaign_recipients(
    retention INTERVAL DEFAULT INTERVAL '1 day',
    batch_size INTEGER DEFAULT 50000
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    IF retention < INTERVAL '1 day' THEN
        RAISE EXCEPTION 'retention must be at least 1 day';
    END IF;

    IF batch_size < 1 OR batch_size > 100000 THEN
        RAISE EXCEPTION 'batch_size must be between 1 and 100000';
    END IF;

    WITH doomed AS (
        SELECT recipient.ctid
        FROM public.campaign_recipients AS recipient
        INNER JOIN public.campaigns AS campaign
            ON campaign.id = recipient.campaign_id
        WHERE campaign.status IN ('completed', 'cancelled', 'failed')
          AND COALESCE(
              campaign.completed_at,
              campaign.updated_at,
              campaign.created_at
          ) < NOW() - retention
        LIMIT batch_size
    )
    DELETE FROM public.campaign_recipients AS recipient
    USING doomed
    WHERE recipient.ctid = doomed.ctid;

    GET DIAGNOSTICS deleted_count = ROW_COUNT;

    UPDATE public.campaigns AS campaign
    SET recipient_history_purged_at = NOW()
    WHERE campaign.status IN ('completed', 'cancelled', 'failed')
      AND campaign.recipient_history_purged_at IS NULL
      AND COALESCE(
          campaign.completed_at,
          campaign.updated_at,
          campaign.created_at
      ) < NOW() - retention
      AND NOT EXISTS (
          SELECT 1
          FROM public.campaign_recipients AS recipient
          WHERE recipient.campaign_id = campaign.id
      );

    RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_terminal_campaign_recipients(INTERVAL, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_terminal_campaign_recipients(INTERVAL, INTEGER) TO postgres;

-- Supabase Cron is backed by pg_cron. The hourly job is deliberately offset
-- from the application's minute-based sending jobs.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

DO $$
DECLARE
    existing_job_id BIGINT;
BEGIN
    SELECT jobid
    INTO existing_job_id
    FROM cron.job
    WHERE jobname = 'tokko-database-retention';

    IF existing_job_id IS NOT NULL THEN
        PERFORM cron.unschedule(existing_job_id);
    END IF;

    PERFORM cron.schedule(
        'tokko-database-retention',
        '17 * * * *',
        'SELECT public.cleanup_terminal_campaign_recipients(INTERVAL ''1 day'', 50000);'
    );
END;
$$;

-- Encourage frequent reuse of dead space in the application's highest-churn
-- tables between physical compactions.
ALTER TABLE campaign_recipients SET (
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_vacuum_threshold = 1000,
    autovacuum_analyze_scale_factor = 0.01
);

ALTER TABLE contacts SET (
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_vacuum_threshold = 500,
    autovacuum_analyze_scale_factor = 0.01
);

ALTER TABLE contact_interactions SET (
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_vacuum_threshold = 1000,
    autovacuum_analyze_scale_factor = 0.02
);


-- <<< END SOURCE: database/migration_database_retention.sql

-- >>> SOURCE: database/migration_database_control_plane.sql
-- Production database control plane.
-- Adds schema-version tracking, health snapshots, configurable maintenance,
-- integrity constraints, and the missing scheduled-recipient index.

CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA app_private TO postgres, service_role;

CREATE TABLE IF NOT EXISTS app_private.schema_migrations (
    version TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_private.database_maintenance_config (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    terminal_recipient_retention INTERVAL NOT NULL DEFAULT INTERVAL '1 day'
        CHECK (terminal_recipient_retention >= INTERVAL '1 day'),
    delete_batch_size INTEGER NOT NULL DEFAULT 50000
        CHECK (delete_batch_size BETWEEN 1 AND 100000),
    snapshot_retention INTERVAL NOT NULL DEFAULT INTERVAL '30 days'
        CHECK (snapshot_retention >= INTERVAL '1 day'),
    run_retention INTERVAL NOT NULL DEFAULT INTERVAL '30 days'
        CHECK (run_retention >= INTERVAL '1 day'),
    cron_log_retention INTERVAL NOT NULL DEFAULT INTERVAL '7 days'
        CHECK (cron_log_retention >= INTERVAL '1 day'),
    warning_database_bytes BIGINT NOT NULL DEFAULT 471859200,
    critical_database_bytes BIGINT NOT NULL DEFAULT 513802240,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (warning_database_bytes > 0),
    CHECK (critical_database_bytes > warning_database_bytes)
);

INSERT INTO app_private.database_maintenance_config (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS app_private.database_health_snapshots (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    database_bytes BIGINT NOT NULL,
    public_schema_bytes BIGINT NOT NULL,
    campaign_recipient_bytes BIGINT NOT NULL,
    pending_recipient_count BIGINT NOT NULL,
    dead_tuple_estimate BIGINT NOT NULL,
    health_status TEXT NOT NULL CHECK (health_status IN ('healthy', 'warning', 'critical')),
    largest_relations JSONB NOT NULL DEFAULT '[]'::JSONB
);

CREATE INDEX IF NOT EXISTS idx_database_health_snapshots_captured
ON app_private.database_health_snapshots(captured_at DESC);

CREATE TABLE IF NOT EXISTS app_private.database_maintenance_runs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
    rows_deleted INTEGER NOT NULL DEFAULT 0,
    database_bytes_before BIGINT,
    database_bytes_after BIGINT,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_database_maintenance_runs_started
ON app_private.database_maintenance_runs(started_at DESC);

-- This index was defined in the scheduling migration but absent in production.
-- It stays tiny until recipient-level schedules are used.
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_scheduled
ON public.campaign_recipients(scheduled_at, status)
WHERE scheduled_at IS NOT NULL;

-- Queries always scope recipient status by campaign or a scheduled timestamp,
-- and best-time queries use contact/page/hour. These global indexes add write
-- cost and substantial Free Plan storage without serving those query shapes.
DROP INDEX IF EXISTS public.idx_campaign_recipients_status;
DROP INDEX IF EXISTS public.idx_contact_interactions_day;
DROP INDEX IF EXISTS public.idx_contact_interactions_interaction_at;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'campaign_recipients_status_check'
          AND conrelid = 'public.campaign_recipients'::REGCLASS
    ) THEN
        ALTER TABLE public.campaign_recipients
        ADD CONSTRAINT campaign_recipients_status_check
        CHECK (status IN ('pending', 'sent', 'failed')) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'campaigns_status_check'
          AND conrelid = 'public.campaigns'::REGCLASS
    ) THEN
        ALTER TABLE public.campaigns
        ADD CONSTRAINT campaigns_status_check
        CHECK (status IN ('draft', 'scheduled', 'sending', 'completed', 'cancelled')) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'campaigns_delivery_counts_check'
          AND conrelid = 'public.campaigns'::REGCLASS
    ) THEN
        ALTER TABLE public.campaigns
        ADD CONSTRAINT campaigns_delivery_counts_check
        CHECK (total_recipients >= 0 AND sent_count >= 0 AND failed_count >= 0) NOT VALID;
    END IF;
END;
$$;

ALTER TABLE public.campaign_recipients
VALIDATE CONSTRAINT campaign_recipients_status_check;
ALTER TABLE public.campaigns
VALIDATE CONSTRAINT campaigns_status_check;
ALTER TABLE public.campaigns
VALIDATE CONSTRAINT campaigns_delivery_counts_check;

CREATE OR REPLACE FUNCTION app_private.capture_database_health()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
    config app_private.database_maintenance_config%ROWTYPE;
    snapshot_id BIGINT;
    database_bytes BIGINT;
    public_bytes BIGINT;
    recipient_bytes BIGINT;
    pending_count BIGINT;
    dead_count BIGINT;
    relation_summary JSONB;
    calculated_status TEXT;
BEGIN
    SELECT * INTO STRICT config
    FROM app_private.database_maintenance_config
    WHERE id = 1;

    SELECT pg_database_size(current_database()) INTO database_bytes;

    SELECT COALESCE(SUM(pg_total_relation_size(class.oid)), 0)
    INTO public_bytes
    FROM pg_class AS class
    INNER JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
    WHERE namespace.nspname = 'public'
      AND class.relkind IN ('r', 'm', 'p');

    SELECT pg_total_relation_size('public.campaign_recipients'::REGCLASS)
    INTO recipient_bytes;

    SELECT COUNT(*) INTO pending_count
    FROM public.campaign_recipients
    WHERE status = 'pending';

    SELECT COALESCE(SUM(n_dead_tup), 0) INTO dead_count
    FROM pg_stat_user_tables;

    SELECT COALESCE(JSONB_AGG(TO_JSONB(relation_row)), '[]'::JSONB)
    INTO relation_summary
    FROM (
        SELECT
            schemaname,
            relname,
            pg_total_relation_size(relid) AS total_bytes,
            n_live_tup AS live_tuple_estimate,
            n_dead_tup AS dead_tuple_estimate
        FROM pg_stat_user_tables
        ORDER BY pg_total_relation_size(relid) DESC
        LIMIT 8
    ) AS relation_row;

    calculated_status := CASE
        WHEN database_bytes >= config.critical_database_bytes THEN 'critical'
        WHEN database_bytes >= config.warning_database_bytes THEN 'warning'
        ELSE 'healthy'
    END;

    INSERT INTO app_private.database_health_snapshots (
        database_bytes,
        public_schema_bytes,
        campaign_recipient_bytes,
        pending_recipient_count,
        dead_tuple_estimate,
        health_status,
        largest_relations
    ) VALUES (
        database_bytes,
        public_bytes,
        recipient_bytes,
        pending_count,
        dead_count,
        calculated_status,
        relation_summary
    )
    RETURNING id INTO snapshot_id;

    RETURN snapshot_id;
END;
$$;

CREATE OR REPLACE FUNCTION app_private.run_database_maintenance()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
    config app_private.database_maintenance_config%ROWTYPE;
    run_started_at TIMESTAMPTZ := clock_timestamp();
    bytes_before BIGINT;
    bytes_after BIGINT;
    deleted_count INTEGER := 0;
    snapshot_id BIGINT;
    failure_message TEXT;
BEGIN
    SELECT * INTO STRICT config
    FROM app_private.database_maintenance_config
    WHERE id = 1;

    SELECT pg_database_size(current_database()) INTO bytes_before;

    deleted_count := public.cleanup_terminal_campaign_recipients(
        config.terminal_recipient_retention,
        config.delete_batch_size
    );

    DELETE FROM app_private.database_health_snapshots
    WHERE captured_at < NOW() - config.snapshot_retention;

    DELETE FROM app_private.database_maintenance_runs
    WHERE started_at < NOW() - config.run_retention;

    DELETE FROM cron.job_run_details
    WHERE end_time IS NOT NULL
      AND end_time < NOW() - config.cron_log_retention;

    snapshot_id := app_private.capture_database_health();
    SELECT pg_database_size(current_database()) INTO bytes_after;

    INSERT INTO app_private.database_maintenance_runs (
        started_at,
        status,
        rows_deleted,
        database_bytes_before,
        database_bytes_after
    ) VALUES (
        run_started_at,
        'success',
        deleted_count,
        bytes_before,
        bytes_after
    );

    RETURN JSONB_BUILD_OBJECT(
        'status', 'success',
        'rows_deleted', deleted_count,
        'database_bytes', bytes_after,
        'snapshot_id', snapshot_id
    );
EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS failure_message = MESSAGE_TEXT;

    INSERT INTO app_private.database_maintenance_runs (
        started_at,
        status,
        rows_deleted,
        database_bytes_before,
        database_bytes_after,
        error_message
    ) VALUES (
        run_started_at,
        'failed',
        deleted_count,
        bytes_before,
        pg_database_size(current_database()),
        failure_message
    );

    RETURN JSONB_BUILD_OBJECT('status', 'failed', 'error', failure_message);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_database_health()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $$
    SELECT COALESCE(
        (
            SELECT JSONB_BUILD_OBJECT(
                'captured_at', captured_at,
                'database_bytes', database_bytes,
                'public_schema_bytes', public_schema_bytes,
                'campaign_recipient_bytes', campaign_recipient_bytes,
                'pending_recipient_count', pending_recipient_count,
                'dead_tuple_estimate', dead_tuple_estimate,
                'health_status', health_status,
                'largest_relations', largest_relations
            )
            FROM app_private.database_health_snapshots
            ORDER BY captured_at DESC
            LIMIT 1
        ),
        '{}'::JSONB
    );
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM PUBLIC, anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA app_private TO postgres;
GRANT ALL ON ALL SEQUENCES IN SCHEMA app_private TO postgres;
GRANT EXECUTE ON FUNCTION app_private.capture_database_health() TO postgres;
GRANT EXECUTE ON FUNCTION app_private.run_database_maintenance() TO postgres;
REVOKE ALL ON FUNCTION public.get_database_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_database_health() TO postgres, service_role;

DO $$
DECLARE
    existing_job_id BIGINT;
BEGIN
    FOR existing_job_id IN
        SELECT jobid
        FROM cron.job
        WHERE jobname IN ('tokko-database-retention', 'tokko-database-maintenance')
    LOOP
        PERFORM cron.unschedule(existing_job_id);
    END LOOP;

    PERFORM cron.schedule(
        'tokko-database-maintenance',
        '17 * * * *',
        'SELECT app_private.run_database_maintenance();'
    );
END;
$$;

INSERT INTO app_private.schema_migrations (version, description)
VALUES
    ('20260808_001', 'Database retention and quota recovery'),
    ('20260808_002', 'Follow-up workflow automation schema repair'),
    ('20260808_003', 'Database control plane and health monitoring')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

SELECT app_private.capture_database_health();
NOTIFY pgrst, 'reload schema';

-- <<< END SOURCE: database/migration_database_control_plane.sql

-- >>> SOURCE: database/migration_compact_contact_interactions.sql
-- Compact raw interaction events into bounded per-contact/hour counters.
--
-- The compatibility view preserves the existing `contact_interactions` API:
-- current application reads still see one logical row per interaction, and
-- inserts are atomically folded into the aggregate table by a view trigger.

CREATE TABLE IF NOT EXISTS app_private.contact_interaction_hourly_stats (
    contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    hour_of_day SMALLINT NOT NULL CHECK (hour_of_day BETWEEN 0 AND 23),
    is_from_contact BOOLEAN NOT NULL DEFAULT TRUE,
    interaction_count INTEGER NOT NULL DEFAULT 1 CHECK (interaction_count > 0),
    first_interaction_at TIMESTAMPTZ NOT NULL,
    last_interaction_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (contact_id, page_id, hour_of_day, is_from_contact),
    CHECK (last_interaction_at >= first_interaction_at)
);

CREATE INDEX IF NOT EXISTS idx_contact_interaction_hourly_page_hour
ON app_private.contact_interaction_hourly_stats(
    page_id,
    is_from_contact,
    hour_of_day,
    contact_id
);

INSERT INTO app_private.contact_interaction_hourly_stats (
    contact_id,
    page_id,
    hour_of_day,
    is_from_contact,
    interaction_count,
    first_interaction_at,
    last_interaction_at
)
SELECT
    contact_id,
    page_id,
    hour_of_day,
    is_from_contact,
    COUNT(*)::INTEGER,
    MIN(interaction_at),
    MAX(interaction_at)
FROM public.contact_interactions
GROUP BY contact_id, page_id, hour_of_day, is_from_contact
ON CONFLICT (contact_id, page_id, hour_of_day, is_from_contact)
DO UPDATE SET
    interaction_count = EXCLUDED.interaction_count,
    first_interaction_at = EXCLUDED.first_interaction_at,
    last_interaction_at = EXCLUDED.last_interaction_at;

DO $$
DECLARE
    raw_count BIGINT;
    aggregate_count BIGINT;
BEGIN
    SELECT COUNT(*) INTO raw_count
    FROM public.contact_interactions;

    SELECT COALESCE(SUM(interaction_count), 0) INTO aggregate_count
    FROM app_private.contact_interaction_hourly_stats;

    IF raw_count <> aggregate_count THEN
        RAISE EXCEPTION
            'Interaction compaction count mismatch: raw %, aggregate %',
            raw_count,
            aggregate_count;
    END IF;
END;
$$;

ALTER TABLE public.contact_interactions
RENAME TO contact_interactions_raw_archive;

CREATE VIEW public.contact_interactions AS
SELECT
    NULL::UUID AS id,
    stats.contact_id,
    stats.page_id,
    stats.last_interaction_at AS interaction_at,
    stats.hour_of_day::INTEGER AS hour_of_day,
    EXTRACT(
        DOW FROM stats.last_interaction_at AT TIME ZONE 'Asia/Manila'
    )::INTEGER AS day_of_week,
    stats.is_from_contact,
    stats.first_interaction_at AS created_at
FROM app_private.contact_interaction_hourly_stats AS stats
CROSS JOIN LATERAL generate_series(1, stats.interaction_count) AS occurrence(number);

CREATE OR REPLACE FUNCTION app_private.record_contact_interaction_from_view()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
    recorded_at TIMESTAMPTZ;
BEGIN
    recorded_at := COALESCE(NEW.interaction_at, NOW());

    INSERT INTO app_private.contact_interaction_hourly_stats (
        contact_id,
        page_id,
        hour_of_day,
        is_from_contact,
        interaction_count,
        first_interaction_at,
        last_interaction_at
    ) VALUES (
        NEW.contact_id,
        NEW.page_id,
        NEW.hour_of_day,
        COALESCE(NEW.is_from_contact, TRUE),
        1,
        recorded_at,
        recorded_at
    )
    ON CONFLICT (contact_id, page_id, hour_of_day, is_from_contact)
    DO UPDATE SET
        interaction_count = app_private.contact_interaction_hourly_stats.interaction_count + 1,
        first_interaction_at = LEAST(
            app_private.contact_interaction_hourly_stats.first_interaction_at,
            EXCLUDED.first_interaction_at
        ),
        last_interaction_at = GREATEST(
            app_private.contact_interaction_hourly_stats.last_interaction_at,
            EXCLUDED.last_interaction_at
        );

    NEW.interaction_at := recorded_at;
    NEW.is_from_contact := COALESCE(NEW.is_from_contact, TRUE);
    NEW.created_at := COALESCE(NEW.created_at, recorded_at);
    RETURN NEW;
END;
$$;

CREATE TRIGGER record_contact_interaction
INSTEAD OF INSERT ON public.contact_interactions
FOR EACH ROW EXECUTE FUNCTION app_private.record_contact_interaction_from_view();

REVOKE ALL ON app_private.contact_interaction_hourly_stats FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_private.record_contact_interaction_from_view() FROM PUBLIC, anon, authenticated;
GRANT ALL ON app_private.contact_interaction_hourly_stats TO postgres;
GRANT EXECUTE ON FUNCTION app_private.record_contact_interaction_from_view() TO postgres;

REVOKE ALL ON public.contact_interactions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.contact_interactions TO postgres, service_role;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260808_004', 'Compact contact interactions into hourly counters')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';


-- <<< END SOURCE: database/migration_compact_contact_interactions.sql

-- >>> SOURCE: database/migration_compact_contact_interactions_finalize.sql
-- Run only after the compatibility view has passed live read/insert checks.

DO $$
DECLARE
    archived_count BIGINT;
    aggregate_count BIGINT;
BEGIN
    SELECT COUNT(*) INTO archived_count
    FROM public.contact_interactions_raw_archive;

    SELECT COALESCE(SUM(interaction_count), 0) INTO aggregate_count
    FROM app_private.contact_interaction_hourly_stats;

    -- New webhook events may already have been folded into the aggregate after
    -- stage one, so the aggregate may be larger but must never be smaller.
    IF aggregate_count < archived_count THEN
        RAISE EXCEPTION
            'Cannot finalize interaction compaction: archive %, aggregate %',
            archived_count,
            aggregate_count;
    END IF;
END;
$$;

DROP TABLE public.contact_interactions_raw_archive;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260808_005', 'Remove verified raw contact interaction archive')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;


-- <<< END SOURCE: database/migration_compact_contact_interactions_finalize.sql

-- >>> SOURCE: database/migration_compact_campaign_delivery_prepare.sql
-- Compact, concurrency-safe campaign delivery queue.
--
-- This migration is deliberately additive so it can be applied before the
-- application deployment. Run migration_compact_campaign_delivery_finalize.sql
-- only after every sender has been upgraded to use the RPCs below.

ALTER TABLE public.campaign_recipients
    ADD COLUMN IF NOT EXISTS claim_token UUID,
    ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

ALTER TABLE public.campaigns
    ADD COLUMN IF NOT EXISTS audience_materialized_at TIMESTAMPTZ;

-- Existing dynamic campaigns already have a materialized audience. Recording
-- that fact prevents a compact sender from re-inserting successful recipients.
UPDATE public.campaigns AS campaign
SET audience_materialized_at = COALESCE(campaign.started_at, campaign.updated_at, NOW())
WHERE campaign.audience_mode = 'dynamic'
  AND campaign.audience_materialized_at IS NULL
  AND EXISTS (
      SELECT 1 FROM public.campaign_recipients AS recipient
      WHERE recipient.campaign_id = campaign.id
  );

ALTER TABLE public.campaign_recipients
    DROP CONSTRAINT IF EXISTS campaign_recipients_status_check;

ALTER TABLE public.campaign_recipients
    ADD CONSTRAINT campaign_recipients_status_check
    CHECK (status IN ('pending', 'processing', 'sent', 'failed')) NOT VALID;

ALTER TABLE public.campaign_recipients
    VALIDATE CONSTRAINT campaign_recipients_status_check;

CREATE TABLE IF NOT EXISTS public.campaign_delivery_failures (
    campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
    contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    error_message TEXT NOT NULL,
    failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attempt_count SMALLINT NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
    PRIMARY KEY (campaign_id, contact_id)
);

ALTER TABLE public.campaign_delivery_failures ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_campaign_delivery_failures_campaign_failed
    ON public.campaign_delivery_failures(campaign_id, failed_at DESC);

INSERT INTO public.campaign_delivery_failures (
    campaign_id, contact_id, error_message, failed_at, attempt_count
)
SELECT
    recipient.campaign_id,
    recipient.contact_id,
    COALESCE(NULLIF(recipient.error_message, ''), 'Unknown delivery error'),
    COALESCE(recipient.last_contacted_at, recipient.created_at, NOW()),
    1
FROM public.campaign_recipients AS recipient
WHERE recipient.status = 'failed'
ON CONFLICT (campaign_id, contact_id) DO UPDATE
SET error_message = EXCLUDED.error_message,
    failed_at = EXCLUDED.failed_at;

-- Keep failure reads complete during the prepare/deploy/finalize transition,
-- including failures written by an older application instance.
CREATE OR REPLACE FUNCTION app_private.mirror_campaign_delivery_failure()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.status = 'failed'
       AND COALESCE(NEW.error_message, '') <> 'Campaign cancelled by user' THEN
        INSERT INTO public.campaign_delivery_failures (
            campaign_id, contact_id, error_message, failed_at, attempt_count
        ) VALUES (
            NEW.campaign_id,
            NEW.contact_id,
            COALESCE(NULLIF(NEW.error_message, ''), 'Unknown delivery error'),
            NOW(),
            1
        )
        ON CONFLICT (campaign_id, contact_id) DO UPDATE
        SET error_message = EXCLUDED.error_message,
            failed_at = EXCLUDED.failed_at,
            attempt_count = LEAST(32767, public.campaign_delivery_failures.attempt_count + 1);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mirror_campaign_delivery_failure ON public.campaign_recipients;
CREATE TRIGGER mirror_campaign_delivery_failure
AFTER INSERT OR UPDATE OF status, error_message ON public.campaign_recipients
FOR EACH ROW
WHEN (NEW.status = 'failed')
EXECUTE FUNCTION app_private.mirror_campaign_delivery_failure();

REVOKE ALL ON FUNCTION app_private.mirror_campaign_delivery_failure() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_private.mirror_campaign_delivery_failure() TO postgres;

-- Extend the existing bounded retention job to the compact failure table.
CREATE OR REPLACE FUNCTION public.cleanup_terminal_campaign_recipients(
    retention INTERVAL DEFAULT INTERVAL '1 day',
    batch_size INTEGER DEFAULT 50000
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_queue_deleted INTEGER := 0;
    v_failures_deleted INTEGER := 0;
BEGIN
    IF retention < INTERVAL '1 day' THEN
        RAISE EXCEPTION 'retention must be at least 1 day';
    END IF;
    IF batch_size < 1 OR batch_size > 100000 THEN
        RAISE EXCEPTION 'batch_size must be between 1 and 100000';
    END IF;

    WITH doomed AS (
        SELECT recipient.ctid
        FROM public.campaign_recipients AS recipient
        INNER JOIN public.campaigns AS campaign ON campaign.id = recipient.campaign_id
        WHERE campaign.status IN ('completed', 'cancelled', 'failed')
          AND COALESCE(campaign.completed_at, campaign.updated_at, campaign.created_at) < NOW() - retention
        LIMIT batch_size
    )
    DELETE FROM public.campaign_recipients AS recipient
    USING doomed
    WHERE recipient.ctid = doomed.ctid;
    GET DIAGNOSTICS v_queue_deleted = ROW_COUNT;

    IF v_queue_deleted < batch_size THEN
        WITH doomed AS (
            SELECT failure.ctid
            FROM public.campaign_delivery_failures AS failure
            INNER JOIN public.campaigns AS campaign ON campaign.id = failure.campaign_id
            WHERE campaign.status IN ('completed', 'cancelled', 'failed')
              AND COALESCE(campaign.completed_at, campaign.updated_at, campaign.created_at) < NOW() - retention
            LIMIT batch_size - v_queue_deleted
        )
        DELETE FROM public.campaign_delivery_failures AS failure
        USING doomed
        WHERE failure.ctid = doomed.ctid;
        GET DIAGNOSTICS v_failures_deleted = ROW_COUNT;
    END IF;

    UPDATE public.campaigns AS campaign
    SET recipient_history_purged_at = NOW()
    WHERE campaign.status IN ('completed', 'cancelled', 'failed')
      AND campaign.recipient_history_purged_at IS NULL
      AND COALESCE(campaign.completed_at, campaign.updated_at, campaign.created_at) < NOW() - retention
      AND NOT EXISTS (
          SELECT 1 FROM public.campaign_recipients AS recipient
          WHERE recipient.campaign_id = campaign.id
      )
      AND NOT EXISTS (
          SELECT 1 FROM public.campaign_delivery_failures AS failure
          WHERE failure.campaign_id = campaign.id
      );

    RETURN v_queue_deleted + v_failures_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_campaign_recipients(
    p_campaign_id UUID,
    p_batch_size INTEGER DEFAULT 25,
    p_due_at TIMESTAMPTZ DEFAULT NULL,
    p_include_unscheduled BOOLEAN DEFAULT FALSE,
    p_lease INTERVAL DEFAULT INTERVAL '10 minutes'
)
RETURNS TABLE (
    contact_id UUID,
    contact_psid TEXT,
    contact_name TEXT,
    contact_best_hour INTEGER,
    claim_token UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_claim_token UUID := gen_random_uuid();
BEGIN
    IF p_batch_size < 1 OR p_batch_size > 500 THEN
        RAISE EXCEPTION 'p_batch_size must be between 1 and 500';
    END IF;

    IF p_lease < INTERVAL '1 minute' OR p_lease > INTERVAL '1 hour' THEN
        RAISE EXCEPTION 'p_lease must be between 1 minute and 1 hour';
    END IF;

    RETURN QUERY
    WITH candidates AS (
        SELECT recipient.ctid
        FROM public.campaign_recipients AS recipient
        WHERE recipient.campaign_id = p_campaign_id
          AND (
              recipient.status = 'pending'
              OR (
                  recipient.status = 'processing'
                  AND recipient.claimed_at < NOW() - p_lease
              )
          )
          AND (
              p_due_at IS NULL
              OR (p_include_unscheduled AND recipient.scheduled_at IS NULL AND recipient.next_scheduled_at IS NULL)
              OR recipient.scheduled_at <= p_due_at
              OR recipient.next_scheduled_at <= p_due_at
          )
        ORDER BY
            COALESCE(recipient.next_scheduled_at, recipient.scheduled_at, recipient.created_at),
            recipient.contact_id
        FOR UPDATE SKIP LOCKED
        LIMIT p_batch_size
    ),
    claimed AS (
        UPDATE public.campaign_recipients AS recipient
        SET status = 'processing',
            claim_token = v_claim_token,
            claimed_at = NOW()
        FROM candidates
        WHERE recipient.ctid = candidates.ctid
        RETURNING recipient.contact_id
    )
    SELECT
        claimed.contact_id,
        contact.psid,
        contact.name,
        contact.best_contact_hour,
        v_claim_token
    FROM claimed
    INNER JOIN public.contacts AS contact ON contact.id = claimed.contact_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_campaign_recipient(
    p_campaign_id UUID,
    p_contact_id UUID,
    p_claim_token UUID,
    p_success BOOLEAN,
    p_error_message TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_loop BOOLEAN;
    v_recurrence TEXT;
    v_matched BOOLEAN := FALSE;
BEGIN
    SELECT campaign.is_loop, COALESCE(campaign.recurrence, 'none')
    INTO v_is_loop, v_recurrence
    FROM public.campaigns AS campaign
    WHERE campaign.id = p_campaign_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    IF COALESCE(v_is_loop, FALSE) OR v_recurrence <> 'none' THEN
        UPDATE public.campaign_recipients AS recipient
        SET status = CASE WHEN p_success THEN 'sent' ELSE 'failed' END,
            sent_at = CASE WHEN p_success THEN NOW() ELSE recipient.sent_at END,
            error_message = CASE WHEN p_success THEN NULL ELSE COALESCE(NULLIF(p_error_message, ''), 'Unknown delivery error') END,
            claim_token = NULL,
            claimed_at = NULL
        WHERE recipient.campaign_id = p_campaign_id
          AND recipient.contact_id = p_contact_id
          AND recipient.status = 'processing'
          AND recipient.claim_token = p_claim_token;
        v_matched := FOUND;
    ELSE
        DELETE FROM public.campaign_recipients AS recipient
        WHERE recipient.campaign_id = p_campaign_id
          AND recipient.contact_id = p_contact_id
          AND recipient.status = 'processing'
          AND recipient.claim_token = p_claim_token;
        v_matched := FOUND;

        IF v_matched AND NOT p_success THEN
            INSERT INTO public.campaign_delivery_failures (
                campaign_id,
                contact_id,
                error_message,
                failed_at,
                attempt_count
            ) VALUES (
                p_campaign_id,
                p_contact_id,
                COALESCE(NULLIF(p_error_message, ''), 'Unknown delivery error'),
                NOW(),
                1
            )
            ON CONFLICT (campaign_id, contact_id) DO UPDATE
            SET error_message = EXCLUDED.error_message,
                failed_at = EXCLUDED.failed_at,
                attempt_count = LEAST(32767, public.campaign_delivery_failures.attempt_count + 1);
        END IF;
    END IF;

    IF v_matched THEN
        UPDATE public.campaigns AS campaign
        SET sent_count = campaign.sent_count + CASE WHEN p_success THEN 1 ELSE 0 END,
            failed_count = campaign.failed_count + CASE WHEN p_success THEN 0 ELSE 1 END,
            updated_at = NOW()
        WHERE campaign.id = p_campaign_id;
    END IF;

    RETURN v_matched;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_campaign_delivery_progress(p_campaign_id UUID)
RETURNS TABLE (
    sent_count INTEGER,
    failed_count INTEGER,
    remaining_count BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        campaign.sent_count,
        campaign.failed_count,
        COUNT(recipient.contact_id)::BIGINT
    FROM public.campaigns AS campaign
    LEFT JOIN public.campaign_recipients AS recipient
      ON recipient.campaign_id = campaign.id
     AND recipient.status IN ('pending', 'processing')
    WHERE campaign.id = p_campaign_id
    GROUP BY campaign.id, campaign.sent_count, campaign.failed_count;
$$;

CREATE OR REPLACE FUNCTION public.finish_campaign_recipient_batch(
    p_campaign_id UUID,
    p_claim_token UUID,
    p_results JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_loop BOOLEAN;
    v_recurrence TEXT;
    v_processed INTEGER := 0;
BEGIN
    IF jsonb_typeof(p_results) <> 'array' OR jsonb_array_length(p_results) > 500 THEN
        RAISE EXCEPTION 'p_results must be an array with at most 500 entries';
    END IF;

    SELECT campaign.is_loop, COALESCE(campaign.recurrence, 'none')
    INTO v_is_loop, v_recurrence
    FROM public.campaigns AS campaign
    WHERE campaign.id = p_campaign_id;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    IF COALESCE(v_is_loop, FALSE) OR v_recurrence <> 'none' THEN
        WITH result_rows AS (
            SELECT result.contact_id, result.success,
                   COALESCE(NULLIF(result.error_message, ''), 'Unknown delivery error') AS error_message
            FROM jsonb_to_recordset(p_results)
                AS result(contact_id UUID, success BOOLEAN, error_message TEXT)
        ),
        finished AS (
            UPDATE public.campaign_recipients AS recipient
            SET status = CASE WHEN result.success THEN 'sent' ELSE 'failed' END,
                sent_at = CASE WHEN result.success THEN NOW() ELSE recipient.sent_at END,
                error_message = CASE WHEN result.success THEN NULL ELSE result.error_message END,
                claim_token = NULL,
                claimed_at = NULL
            FROM result_rows AS result
            WHERE recipient.campaign_id = p_campaign_id
              AND recipient.contact_id = result.contact_id
              AND recipient.status = 'processing'
              AND recipient.claim_token = p_claim_token
            RETURNING recipient.contact_id, result.success, result.error_message
        )
        SELECT COUNT(*)::INTEGER INTO v_processed FROM finished;
    ELSE
        WITH result_rows AS (
            SELECT result.contact_id, result.success,
                   COALESCE(NULLIF(result.error_message, ''), 'Unknown delivery error') AS error_message
            FROM jsonb_to_recordset(p_results)
                AS result(contact_id UUID, success BOOLEAN, error_message TEXT)
        ),
        finished AS (
            DELETE FROM public.campaign_recipients AS recipient
            USING result_rows AS result
            WHERE recipient.campaign_id = p_campaign_id
              AND recipient.contact_id = result.contact_id
              AND recipient.status = 'processing'
              AND recipient.claim_token = p_claim_token
            RETURNING recipient.contact_id, result.success, result.error_message
        ),
        failures AS (
            INSERT INTO public.campaign_delivery_failures (
                campaign_id, contact_id, error_message, failed_at, attempt_count
            )
            SELECT p_campaign_id, finished.contact_id, finished.error_message, NOW(), 1
            FROM finished
            WHERE NOT finished.success
            ON CONFLICT (campaign_id, contact_id) DO UPDATE
            SET error_message = EXCLUDED.error_message,
                failed_at = EXCLUDED.failed_at,
                attempt_count = LEAST(32767, public.campaign_delivery_failures.attempt_count + 1)
            RETURNING 1
        )
        SELECT COUNT(*)::INTEGER INTO v_processed FROM finished;
    END IF;

    WITH result_rows AS (
        SELECT result.success
        FROM jsonb_to_recordset(p_results)
            AS result(contact_id UUID, success BOOLEAN, error_message TEXT)
    )
    UPDATE public.campaigns AS campaign
    SET sent_count = campaign.sent_count + (
            SELECT COUNT(*)::INTEGER FROM result_rows WHERE success
        ),
        failed_count = campaign.failed_count + (
            SELECT COUNT(*)::INTEGER FROM result_rows WHERE NOT success
        ),
        updated_at = NOW()
    WHERE campaign.id = p_campaign_id
      AND v_processed = jsonb_array_length(p_results);

    IF v_processed <> jsonb_array_length(p_results) THEN
        RAISE EXCEPTION 'one or more recipient claims expired before batch completion';
    END IF;

    RETURN v_processed;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_loop_campaign_recipient(
    p_campaign_id UUID,
    p_contact_id UUID,
    p_claim_token UUID,
    p_success BOOLEAN,
    p_next_scheduled_at TIMESTAMPTZ DEFAULT NULL,
    p_error_message TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_matched BOOLEAN := FALSE;
BEGIN
    UPDATE public.campaign_recipients AS recipient
    SET status = CASE WHEN p_success THEN 'pending' ELSE 'failed' END,
        message_sent_count = COALESCE(recipient.message_sent_count, 0) + 1,
        last_contacted_at = CASE WHEN p_success THEN NOW() ELSE recipient.last_contacted_at END,
        next_scheduled_at = CASE WHEN p_success THEN p_next_scheduled_at ELSE recipient.next_scheduled_at END,
        scheduled_at = CASE WHEN p_success THEN NULL ELSE recipient.scheduled_at END,
        error_message = CASE WHEN p_success THEN NULL ELSE COALESCE(NULLIF(p_error_message, ''), 'Unknown delivery error') END,
        claim_token = NULL,
        claimed_at = NULL
    WHERE recipient.campaign_id = p_campaign_id
      AND recipient.contact_id = p_contact_id
      AND recipient.status = 'processing'
      AND recipient.claim_token = p_claim_token;
    v_matched := FOUND;

    RETURN v_matched;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_campaign_delivery(p_campaign_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_deleted INTEGER;
BEGIN
    UPDATE public.campaigns AS campaign
    SET status = 'cancelled',
        updated_at = NOW()
    WHERE campaign.id = p_campaign_id
      AND campaign.status = 'sending';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'campaign is not currently sending';
    END IF;

    DELETE FROM public.campaign_recipients AS recipient
    WHERE recipient.campaign_id = p_campaign_id
      AND recipient.status = 'pending';
    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_campaign_recipients(UUID, INTEGER, TIMESTAMPTZ, BOOLEAN, INTERVAL) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_campaign_recipient(UUID, UUID, UUID, BOOLEAN, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_campaign_delivery_progress(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_campaign_recipient_batch(UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_loop_campaign_recipient(UUID, UUID, UUID, BOOLEAN, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_campaign_delivery(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.claim_campaign_recipients(UUID, INTEGER, TIMESTAMPTZ, BOOLEAN, INTERVAL) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.finish_campaign_recipient(UUID, UUID, UUID, BOOLEAN, TEXT) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.get_campaign_delivery_progress(UUID) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.finish_campaign_recipient_batch(UUID, UUID, JSONB) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.finish_loop_campaign_recipient(UUID, UUID, UUID, BOOLEAN, TIMESTAMPTZ, TEXT) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_campaign_delivery(UUID) TO postgres, service_role;
GRANT ALL ON public.campaign_delivery_failures TO postgres, service_role;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260808_006', 'Atomic compact campaign delivery queue preparation')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';


-- <<< END SOURCE: database/migration_compact_campaign_delivery_prepare.sql

-- >>> SOURCE: database/migration_atomic_tracked_bulk_campaign.sql
-- Create large filtered tracked campaigns in one database transaction.
-- This avoids hundreds of PostgREST round trips and guarantees that a
-- campaign cannot survive with only part of its audience materialized.

CREATE OR REPLACE FUNCTION public.create_filtered_tracked_bulk_campaign(
    p_page_id UUID,
    p_created_by UUID,
    p_name TEXT,
    p_message_text TEXT,
    p_template_name TEXT DEFAULT NULL,
    p_template_language TEXT DEFAULT NULL,
    p_search TEXT DEFAULT NULL,
    p_include_tag_ids UUID[] DEFAULT ARRAY[]::UUID[],
    p_exclude_tag_ids UUID[] DEFAULT ARRAY[]::UUID[],
    p_excluded_contact_ids UUID[] DEFAULT ARRAY[]::UUID[],
    p_date_from DATE DEFAULT NULL,
    p_date_to DATE DEFAULT NULL,
    p_date_filter_mode TEXT DEFAULT 'include',
    p_slice_offset INTEGER DEFAULT 0,
    p_slice_limit INTEGER DEFAULT NULL
)
RETURNS TABLE (
    campaign_id UUID,
    recipient_count INTEGER,
    total_matched INTEGER,
    audience_materialized_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_campaign_id UUID := pg_catalog.gen_random_uuid();
    v_matched_contact_ids UUID[] := ARRAY[]::UUID[];
    v_selected_contact_ids UUID[] := ARRAY[]::UUID[];
    v_total_matched INTEGER := 0;
    v_recipient_count INTEGER := 0;
    v_materialized_at TIMESTAMPTZ := clock_timestamp();
    v_slice_offset INTEGER := GREATEST(COALESCE(p_slice_offset, 0), 0);
BEGIN
    IF p_page_id IS NULL OR p_created_by IS NULL THEN
        RAISE EXCEPTION 'Page and creator are required.' USING ERRCODE = '22023';
    END IF;

    IF COALESCE(BTRIM(p_name), '') = '' OR COALESCE(BTRIM(p_message_text), '') = '' THEN
        RAISE EXCEPTION 'Campaign name and message are required.' USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(
        ARRAY_AGG(contact.id ORDER BY contact.last_interaction_at DESC NULLS LAST, contact.id),
        ARRAY[]::UUID[]
    )
    INTO v_matched_contact_ids
    FROM contacts AS contact
    WHERE contact.page_id = p_page_id
      AND contact.psid IS NOT NULL
      AND contact.psid <> ''
      AND (
          COALESCE(BTRIM(p_search), '') = ''
          OR contact.name ILIKE ('%' || BTRIM(p_search) || '%')
      )
      AND (
          COALESCE(CARDINALITY(p_include_tag_ids), 0) = 0
          OR EXISTS (
              SELECT 1
              FROM contact_tags AS included_tag
              WHERE included_tag.contact_id = contact.id
                AND included_tag.tag_id = ANY(p_include_tag_ids)
          )
      )
      AND (
          COALESCE(CARDINALITY(p_exclude_tag_ids), 0) = 0
          OR NOT EXISTS (
              SELECT 1
              FROM contact_tags AS excluded_tag
              WHERE excluded_tag.contact_id = contact.id
                AND excluded_tag.tag_id = ANY(p_exclude_tag_ids)
          )
      )
      AND (
          COALESCE(CARDINALITY(p_excluded_contact_ids), 0) = 0
          OR contact.id <> ALL(p_excluded_contact_ids)
      )
      AND (
          LOWER(COALESCE(p_date_filter_mode, 'include')) <> 'exclude'
          AND (p_date_from IS NULL OR COALESCE(contact.first_interaction_at, contact.created_at) >= p_date_from::TIMESTAMPTZ)
          AND (p_date_to IS NULL OR COALESCE(contact.first_interaction_at, contact.created_at) < (p_date_to + 1)::TIMESTAMPTZ)
          OR
          LOWER(COALESCE(p_date_filter_mode, 'include')) = 'exclude'
          AND (
              (p_date_from IS NULL AND p_date_to IS NULL)
              OR (p_date_from IS NOT NULL AND COALESCE(contact.first_interaction_at, contact.created_at) < p_date_from::TIMESTAMPTZ)
              OR (p_date_to IS NOT NULL AND COALESCE(contact.first_interaction_at, contact.created_at) >= (p_date_to + 1)::TIMESTAMPTZ)
          )
      );

    v_total_matched := COALESCE(CARDINALITY(v_matched_contact_ids), 0);

    IF p_slice_limit IS NULL THEN
        v_selected_contact_ids := v_matched_contact_ids;
    ELSIF p_slice_limit > 0 AND v_slice_offset < v_total_matched THEN
        v_selected_contact_ids := v_matched_contact_ids[
            (v_slice_offset + 1):LEAST(v_slice_offset + p_slice_limit, v_total_matched)
        ];
    END IF;

    v_recipient_count := COALESCE(CARDINALITY(v_selected_contact_ids), 0);
    IF v_recipient_count = 0 THEN
        RAISE EXCEPTION 'No sendable contacts matched this selection.' USING ERRCODE = '22023';
    END IF;

    INSERT INTO campaigns (
        id,
        page_id,
        name,
        message_text,
        status,
        total_recipients,
        sent_count,
        failed_count,
        created_by,
        audience_mode,
        audience_materialized_at,
        use_best_time,
        is_loop,
        loop_status,
        use_ai_message,
        template_name,
        template_language,
        recurrence,
        created_at,
        updated_at
    ) VALUES (
        v_campaign_id,
        p_page_id,
        BTRIM(p_name),
        p_message_text,
        'draft',
        v_recipient_count,
        0,
        0,
        p_created_by,
        'specific',
        v_materialized_at,
        FALSE,
        FALSE,
        'stopped',
        FALSE,
        NULLIF(BTRIM(p_template_name), ''),
        CASE WHEN NULLIF(BTRIM(p_template_name), '') IS NULL THEN NULL ELSE NULLIF(BTRIM(p_template_language), '') END,
        'none',
        v_materialized_at,
        v_materialized_at
    );

    INSERT INTO campaign_recipients (campaign_id, contact_id, status)
    SELECT v_campaign_id, selected_contact_id, 'pending'
    FROM UNNEST(v_selected_contact_ids) AS selected_contact_id;

    RETURN QUERY
    SELECT v_campaign_id, v_recipient_count, v_total_matched, v_materialized_at;
END;
$$;

ALTER FUNCTION public.create_filtered_tracked_bulk_campaign(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID[], UUID[], UUID[], DATE, DATE, TEXT, INTEGER, INTEGER
) SET statement_timeout = '0';

REVOKE ALL ON FUNCTION public.create_filtered_tracked_bulk_campaign(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID[], UUID[], UUID[], DATE, DATE, TEXT, INTEGER, INTEGER
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_filtered_tracked_bulk_campaign(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID[], UUID[], UUID[], DATE, DATE, TEXT, INTEGER, INTEGER
) TO service_role;

NOTIFY pgrst, 'reload schema';


-- <<< END SOURCE: database/migration_atomic_tracked_bulk_campaign.sql

-- >>> SOURCE: database/migration_million_contact_campaigns.sql
-- Scale one-time campaigns to million-contact audiences without moving the
-- complete contact-id set through application memory. Delivery remains a
-- compact, resumable queue and immediate campaigns can be continued by cron.

ALTER TABLE public.campaigns
ADD COLUMN IF NOT EXISTS template_media_header JSONB;

ALTER TABLE public.campaigns
ADD COLUMN IF NOT EXISTS template_media_headers JSONB;

ALTER TABLE public.campaigns
ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

ALTER TABLE public.campaigns
ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_campaigns_immediate_sending
ON public.campaigns (next_attempt_at, updated_at, id)
WHERE status = 'sending'
  AND scheduled_at IS NULL
  AND NOT COALESCE(is_loop, FALSE);

CREATE INDEX IF NOT EXISTS idx_contacts_page_first_interaction
ON public.contacts (page_id, (COALESCE(first_interaction_at, created_at)));

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS idx_contacts_name_trgm
ON public.contacts USING GIN (name extensions.gin_trgm_ops);

-- Replace the array-based implementation. The previous function aggregated
-- every matching UUID into one PostgreSQL array before inserting recipients;
-- this version streams the selected rows directly into the queue.
CREATE OR REPLACE FUNCTION public.create_filtered_tracked_bulk_campaign(
    p_page_id UUID,
    p_created_by UUID,
    p_name TEXT,
    p_message_text TEXT,
    p_template_name TEXT DEFAULT NULL,
    p_template_language TEXT DEFAULT NULL,
    p_search TEXT DEFAULT NULL,
    p_include_tag_ids UUID[] DEFAULT ARRAY[]::UUID[],
    p_exclude_tag_ids UUID[] DEFAULT ARRAY[]::UUID[],
    p_excluded_contact_ids UUID[] DEFAULT ARRAY[]::UUID[],
    p_date_from DATE DEFAULT NULL,
    p_date_to DATE DEFAULT NULL,
    p_date_filter_mode TEXT DEFAULT 'include',
    p_slice_offset INTEGER DEFAULT 0,
    p_slice_limit INTEGER DEFAULT NULL
)
RETURNS TABLE (
    campaign_id UUID,
    recipient_count INTEGER,
    total_matched INTEGER,
    audience_materialized_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp, extensions
AS $$
DECLARE
    v_campaign_id UUID := pg_catalog.gen_random_uuid();
    v_total_matched BIGINT := 0;
    v_recipient_count BIGINT := 0;
    v_materialized_at TIMESTAMPTZ := clock_timestamp();
    v_slice_offset INTEGER := GREATEST(COALESCE(p_slice_offset, 0), 0);
BEGIN
    IF p_page_id IS NULL OR p_created_by IS NULL THEN
        RAISE EXCEPTION 'Page and creator are required.' USING ERRCODE = '22023';
    END IF;

    IF COALESCE(BTRIM(p_name), '') = '' OR COALESCE(BTRIM(p_message_text), '') = '' THEN
        RAISE EXCEPTION 'Campaign name and message are required.' USING ERRCODE = '22023';
    END IF;

    IF p_slice_limit IS NOT NULL AND p_slice_limit < 1 THEN
        RAISE EXCEPTION 'Slice limit must be positive.' USING ERRCODE = '22023';
    END IF;

    SELECT COUNT(*)
    INTO v_total_matched
    FROM public.contacts AS contact
    WHERE contact.page_id = p_page_id
      AND contact.psid IS NOT NULL
      AND contact.psid <> ''
      AND (
          COALESCE(BTRIM(p_search), '') = ''
          OR contact.name ILIKE ('%' || BTRIM(p_search) || '%')
      )
      AND (
          COALESCE(CARDINALITY(p_include_tag_ids), 0) = 0
          OR EXISTS (
              SELECT 1
              FROM public.contact_tags AS included_tag
              WHERE included_tag.contact_id = contact.id
                AND included_tag.tag_id = ANY(p_include_tag_ids)
          )
      )
      AND (
          COALESCE(CARDINALITY(p_exclude_tag_ids), 0) = 0
          OR NOT EXISTS (
              SELECT 1
              FROM public.contact_tags AS excluded_tag
              WHERE excluded_tag.contact_id = contact.id
                AND excluded_tag.tag_id = ANY(p_exclude_tag_ids)
          )
      )
      AND (
          COALESCE(CARDINALITY(p_excluded_contact_ids), 0) = 0
          OR contact.id <> ALL(p_excluded_contact_ids)
      )
      AND (
          (
              LOWER(COALESCE(p_date_filter_mode, 'include')) <> 'exclude'
              AND (p_date_from IS NULL OR COALESCE(contact.first_interaction_at, contact.created_at) >= p_date_from::TIMESTAMPTZ)
              AND (p_date_to IS NULL OR COALESCE(contact.first_interaction_at, contact.created_at) < (p_date_to + 1)::TIMESTAMPTZ)
          )
          OR
          (
              LOWER(COALESCE(p_date_filter_mode, 'include')) = 'exclude'
              AND (
                  (p_date_from IS NULL AND p_date_to IS NULL)
                  OR (p_date_from IS NOT NULL AND COALESCE(contact.first_interaction_at, contact.created_at) < p_date_from::TIMESTAMPTZ)
                  OR (p_date_to IS NOT NULL AND COALESCE(contact.first_interaction_at, contact.created_at) >= (p_date_to + 1)::TIMESTAMPTZ)
              )
          )
      );

    IF v_total_matched = 0 OR v_slice_offset >= v_total_matched THEN
        RAISE EXCEPTION 'No sendable contacts matched this selection.' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.campaigns (
        id, page_id, name, message_text, status, total_recipients,
        sent_count, failed_count, created_by, audience_mode,
        audience_materialized_at, use_best_time, is_loop, loop_status,
        use_ai_message, template_name, template_language, recurrence,
        created_at, updated_at
    ) VALUES (
        v_campaign_id, p_page_id, BTRIM(p_name), p_message_text, 'draft', 0,
        0, 0, p_created_by, 'specific', NULL, FALSE, FALSE, 'stopped', FALSE,
        NULLIF(BTRIM(p_template_name), ''),
        CASE WHEN NULLIF(BTRIM(p_template_name), '') IS NULL THEN NULL ELSE NULLIF(BTRIM(p_template_language), '') END,
        'none', v_materialized_at, v_materialized_at
    );

    INSERT INTO public.campaign_recipients (campaign_id, contact_id, status)
    SELECT v_campaign_id, selected.id, 'pending'
    FROM (
        SELECT contact.id
        FROM public.contacts AS contact
        WHERE contact.page_id = p_page_id
          AND contact.psid IS NOT NULL
          AND contact.psid <> ''
          AND (
              COALESCE(BTRIM(p_search), '') = ''
              OR contact.name ILIKE ('%' || BTRIM(p_search) || '%')
          )
          AND (
              COALESCE(CARDINALITY(p_include_tag_ids), 0) = 0
              OR EXISTS (
                  SELECT 1 FROM public.contact_tags AS included_tag
                  WHERE included_tag.contact_id = contact.id
                    AND included_tag.tag_id = ANY(p_include_tag_ids)
              )
          )
          AND (
              COALESCE(CARDINALITY(p_exclude_tag_ids), 0) = 0
              OR NOT EXISTS (
                  SELECT 1 FROM public.contact_tags AS excluded_tag
                  WHERE excluded_tag.contact_id = contact.id
                    AND excluded_tag.tag_id = ANY(p_exclude_tag_ids)
              )
          )
          AND (
              COALESCE(CARDINALITY(p_excluded_contact_ids), 0) = 0
              OR contact.id <> ALL(p_excluded_contact_ids)
          )
          AND (
              (
                  LOWER(COALESCE(p_date_filter_mode, 'include')) <> 'exclude'
                  AND (p_date_from IS NULL OR COALESCE(contact.first_interaction_at, contact.created_at) >= p_date_from::TIMESTAMPTZ)
                  AND (p_date_to IS NULL OR COALESCE(contact.first_interaction_at, contact.created_at) < (p_date_to + 1)::TIMESTAMPTZ)
              )
              OR
              (
                  LOWER(COALESCE(p_date_filter_mode, 'include')) = 'exclude'
                  AND (
                      (p_date_from IS NULL AND p_date_to IS NULL)
                      OR (p_date_from IS NOT NULL AND COALESCE(contact.first_interaction_at, contact.created_at) < p_date_from::TIMESTAMPTZ)
                      OR (p_date_to IS NOT NULL AND COALESCE(contact.first_interaction_at, contact.created_at) >= (p_date_to + 1)::TIMESTAMPTZ)
                  )
              )
          )
        ORDER BY contact.last_interaction_at DESC NULLS LAST, contact.id
        OFFSET v_slice_offset
        LIMIT p_slice_limit
    ) AS selected;

    GET DIAGNOSTICS v_recipient_count = ROW_COUNT;
    IF v_recipient_count = 0 THEN
        RAISE EXCEPTION 'No sendable contacts matched this selection.' USING ERRCODE = '22023';
    END IF;

    UPDATE public.campaigns AS campaign
    SET total_recipients = v_recipient_count::INTEGER,
        audience_materialized_at = v_materialized_at,
        updated_at = v_materialized_at
    WHERE campaign.id = v_campaign_id;

    RETURN QUERY
    SELECT
        v_campaign_id,
        v_recipient_count::INTEGER,
        v_total_matched::INTEGER,
        v_materialized_at;
END;
$$;

ALTER FUNCTION public.create_filtered_tracked_bulk_campaign(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID[], UUID[], UUID[], DATE, DATE, TEXT, INTEGER, INTEGER
) SET statement_timeout = '0';

REVOKE ALL ON FUNCTION public.create_filtered_tracked_bulk_campaign(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID[], UUID[], UUID[], DATE, DATE, TEXT, INTEGER, INTEGER
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_filtered_tracked_bulk_campaign(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID[], UUID[], UUID[], DATE, DATE, TEXT, INTEGER, INTEGER
) TO service_role;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260813_010', 'Scale materialization and delivery recovery to million-contact campaigns')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';


-- <<< END SOURCE: database/migration_million_contact_campaigns.sql

-- >>> SOURCE: database/migration_campaign_send_resilience.sql
-- Keep dynamic audiences and campaign delivery bounded at million-contact scale.
-- Audience rows are inserted directly by PostgreSQL instead of returning every
-- contact UUID to a serverless function.

CREATE OR REPLACE FUNCTION public.materialize_dynamic_campaign_audience(
    p_campaign_id UUID
)
RETURNS TABLE (
    recipient_count BIGINT,
    audience_materialized_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_campaign public.campaigns%ROWTYPE;
    v_recipient_count BIGINT;
    v_materialized_at TIMESTAMPTZ := clock_timestamp();
BEGIN
    SELECT *
    INTO v_campaign
    FROM public.campaigns AS campaign
    WHERE campaign.id = p_campaign_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Campaign not found.' USING ERRCODE = 'P0002';
    END IF;

    IF v_campaign.audience_mode <> 'dynamic' THEN
        RAISE EXCEPTION 'Campaign audience is not dynamic.' USING ERRCODE = '22023';
    END IF;

    IF v_campaign.audience_materialized_at IS NOT NULL THEN
        RETURN QUERY SELECT v_campaign.total_recipients::BIGINT, v_campaign.audience_materialized_at;
        RETURN;
    END IF;

    INSERT INTO public.campaign_recipients (campaign_id, contact_id, status)
    SELECT v_campaign.id, contact.id, 'pending'
    FROM public.contacts AS contact
    WHERE contact.page_id = v_campaign.page_id
      AND contact.psid IS NOT NULL
      AND contact.psid <> ''
      AND (
          v_campaign.audience_start_date IS NULL
          OR COALESCE(contact.first_interaction_at, contact.created_at) >= v_campaign.audience_start_date::TIMESTAMPTZ
      )
      AND (
          COALESCE(jsonb_array_length(v_campaign.audience_include_tag_ids), 0) = 0
          OR EXISTS (
              SELECT 1
              FROM public.contact_tags AS included_tag
              WHERE included_tag.contact_id = contact.id
                AND included_tag.tag_id::TEXT IN (
                    SELECT jsonb_array_elements_text(v_campaign.audience_include_tag_ids)
                )
          )
      )
      AND (
          COALESCE(jsonb_array_length(v_campaign.audience_exclude_tag_ids), 0) = 0
          OR NOT EXISTS (
              SELECT 1
              FROM public.contact_tags AS excluded_tag
              WHERE excluded_tag.contact_id = contact.id
                AND excluded_tag.tag_id::TEXT IN (
                    SELECT jsonb_array_elements_text(v_campaign.audience_exclude_tag_ids)
                )
          )
      )
    ON CONFLICT (campaign_id, contact_id) DO NOTHING;

    SELECT COUNT(*)
    INTO v_recipient_count
    FROM public.campaign_recipients AS recipient
    WHERE recipient.campaign_id = v_campaign.id;

    UPDATE public.campaigns AS campaign
    SET total_recipients = v_recipient_count::INTEGER,
        audience_materialized_at = v_materialized_at,
        updated_at = v_materialized_at
    WHERE campaign.id = v_campaign.id;

    RETURN QUERY SELECT v_recipient_count, v_materialized_at;
END;
$$;

ALTER FUNCTION public.materialize_dynamic_campaign_audience(UUID)
SET statement_timeout = '0';

REVOKE ALL ON FUNCTION public.materialize_dynamic_campaign_audience(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.materialize_dynamic_campaign_audience(UUID) TO service_role;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260813_011', 'Million-contact dynamic audience materialization and send resilience')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';


-- <<< END SOURCE: database/migration_campaign_send_resilience.sql

-- >>> SOURCE: database/migration_campaign_delivery_timeout_fix.sql
-- Remove high-volume tracked-campaign statement timeouts without adding a
-- large queue index. The compact queue primary key already starts with
-- (campaign_id, contact_id), so immediate sends can claim in contact-id order
-- instead of sorting the campaign's entire remaining audience for every batch.

CREATE OR REPLACE FUNCTION public.claim_campaign_recipients(
    p_campaign_id UUID,
    p_batch_size INTEGER DEFAULT 25,
    p_due_at TIMESTAMPTZ DEFAULT NULL,
    p_include_unscheduled BOOLEAN DEFAULT FALSE,
    p_lease INTERVAL DEFAULT INTERVAL '10 minutes'
)
RETURNS TABLE (
    contact_id UUID,
    contact_psid TEXT,
    contact_name TEXT,
    contact_best_hour INTEGER,
    claim_token UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_claim_token UUID := gen_random_uuid();
BEGIN
    IF p_batch_size < 1 OR p_batch_size > 500 THEN
        RAISE EXCEPTION 'p_batch_size must be between 1 and 500';
    END IF;

    IF p_lease < INTERVAL '1 minute' OR p_lease > INTERVAL '1 hour' THEN
        RAISE EXCEPTION 'p_lease must be between 1 minute and 1 hour';
    END IF;

    IF p_due_at IS NULL THEN
        RETURN QUERY
        WITH candidates AS (
            SELECT recipient.ctid
            FROM public.campaign_recipients AS recipient
            WHERE recipient.campaign_id = p_campaign_id
              AND (
                  recipient.status = 'pending'
                  OR (
                      recipient.status = 'processing'
                      AND recipient.claimed_at < NOW() - p_lease
                  )
              )
            -- Uses the compact (campaign_id, contact_id) primary key and stops
            -- after the requested rows instead of sorting the whole campaign.
            ORDER BY recipient.contact_id
            FOR UPDATE SKIP LOCKED
            LIMIT p_batch_size
        ),
        claimed AS (
            UPDATE public.campaign_recipients AS recipient
            SET status = 'processing',
                claim_token = v_claim_token,
                claimed_at = NOW()
            FROM candidates
            WHERE recipient.ctid = candidates.ctid
            RETURNING recipient.contact_id
        )
        SELECT
            claimed.contact_id,
            contact.psid,
            contact.name,
            contact.best_contact_hour,
            v_claim_token
        FROM claimed
        INNER JOIN public.contacts AS contact ON contact.id = claimed.contact_id;
    ELSE
        RETURN QUERY
        WITH candidates AS (
            SELECT recipient.ctid
            FROM public.campaign_recipients AS recipient
            WHERE recipient.campaign_id = p_campaign_id
              AND (
                  recipient.status = 'pending'
                  OR (
                      recipient.status = 'processing'
                      AND recipient.claimed_at < NOW() - p_lease
                  )
              )
              AND (
                  (p_include_unscheduled AND recipient.scheduled_at IS NULL AND recipient.next_scheduled_at IS NULL)
                  OR recipient.scheduled_at <= p_due_at
                  OR recipient.next_scheduled_at <= p_due_at
              )
            ORDER BY
                COALESCE(recipient.next_scheduled_at, recipient.scheduled_at, recipient.created_at),
                recipient.contact_id
            FOR UPDATE SKIP LOCKED
            LIMIT p_batch_size
        ),
        claimed AS (
            UPDATE public.campaign_recipients AS recipient
            SET status = 'processing',
                claim_token = v_claim_token,
                claimed_at = NOW()
            FROM candidates
            WHERE recipient.ctid = candidates.ctid
            RETURNING recipient.contact_id
        )
        SELECT
            claimed.contact_id,
            contact.psid,
            contact.name,
            contact.best_contact_hour,
            v_claim_token
        FROM claimed
        INNER JOIN public.contacts AS contact ON contact.id = claimed.contact_id;
    END IF;
END;
$$;

-- A fully materialized one-time campaign has exact durable counters, so its
-- remaining count is arithmetic. Older or scheduled/loop campaigns retain the
-- queue-count fallback until their materialization state is known.
CREATE OR REPLACE FUNCTION public.get_campaign_delivery_progress(p_campaign_id UUID)
RETURNS TABLE (
    sent_count INTEGER,
    failed_count INTEGER,
    remaining_count BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        campaign.sent_count,
        campaign.failed_count,
        CASE
            WHEN campaign.audience_materialized_at IS NOT NULL
             AND NOT COALESCE(campaign.is_loop, FALSE)
             AND COALESCE(campaign.recurrence, 'none') = 'none'
            THEN GREATEST(
                campaign.total_recipients - campaign.sent_count - campaign.failed_count,
                0
            )::BIGINT
            ELSE (
                SELECT COUNT(*)::BIGINT
                FROM public.campaign_recipients AS recipient
                WHERE recipient.campaign_id = campaign.id
                  AND recipient.status IN ('pending', 'processing')
            )
        END
    FROM public.campaigns AS campaign
    WHERE campaign.id = p_campaign_id;
$$;

REVOKE ALL ON FUNCTION public.claim_campaign_recipients(UUID, INTEGER, TIMESTAMPTZ, BOOLEAN, INTERVAL) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_campaign_delivery_progress(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_campaign_recipients(UUID, INTEGER, TIMESTAMPTZ, BOOLEAN, INTERVAL) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.get_campaign_delivery_progress(UUID) TO postgres, service_role;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260812_008', 'Remove tracked campaign delivery statement timeouts')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';


-- <<< END SOURCE: database/migration_campaign_delivery_timeout_fix.sql

-- >>> SOURCE: database/migration_resumable_campaign_pause.sql
-- Preserve a campaign's durable recipient queue when a user stops delivery.
-- Successful and failed recipients are already removed from the active queue;
-- pending/processing rows therefore represent exactly the contacts that still
-- need an attempt when the campaign is continued.

CREATE OR REPLACE FUNCTION public.pause_campaign_delivery(p_campaign_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_remaining INTEGER;
BEGIN
    UPDATE public.campaigns AS campaign
    SET status = 'draft',
        background_delivery_enabled = FALSE,
        next_attempt_at = NULL,
        completed_at = NULL,
        last_error = 'Stopped manually. Unsent recipients remain queued.',
        updated_at = NOW()
    WHERE campaign.id = p_campaign_id
      AND campaign.status IN ('sending', 'scheduled');

    IF NOT FOUND THEN
        RAISE EXCEPTION 'campaign is not currently sending';
    END IF;

    SELECT COUNT(*)::INTEGER
    INTO v_remaining
    FROM public.campaign_recipients AS recipient
    WHERE recipient.campaign_id = p_campaign_id
      AND recipient.status IN ('pending', 'processing');

    RETURN COALESCE(v_remaining, 0);
END;
$$;

-- Keep the old RPC name safe for already-deployed clients during rollout.
-- "Cancel" now means a resumable stop and never discards unsent recipients.
CREATE OR REPLACE FUNCTION public.cancel_campaign_delivery(p_campaign_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN public.pause_campaign_delivery(p_campaign_id);
END;
$$;

REVOKE ALL ON FUNCTION public.pause_campaign_delivery(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_campaign_delivery(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pause_campaign_delivery(UUID) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_campaign_delivery(UUID) TO postgres, service_role;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260816_013', 'Preserve unsent campaign recipients across manual stops')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';


-- <<< END SOURCE: database/migration_resumable_campaign_pause.sql

-- >>> SOURCE: database/migration_campaign_background_delivery.sql
-- Prevent abandoned legacy campaigns from starving newly-started durable
-- campaigns. A campaign becomes eligible when the user starts/resumes it.

ALTER TABLE public.campaigns
ADD COLUMN IF NOT EXISTS background_delivery_enabled BOOLEAN NOT NULL DEFAULT FALSE;

DROP INDEX IF EXISTS public.idx_campaigns_immediate_sending;

CREATE INDEX idx_campaigns_immediate_sending
ON public.campaigns (next_attempt_at, updated_at, id)
WHERE status = 'sending'
  AND scheduled_at IS NULL
  AND background_delivery_enabled
  AND NOT COALESCE(is_loop, FALSE);

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260814_012', 'Isolate explicitly resumed background campaigns from abandoned queues')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';


-- <<< END SOURCE: database/migration_campaign_background_delivery.sql

-- >>> SOURCE: database/migration_contact_sync_load_control.sql
-- Prevent concurrent full contact syncs for one page and speed up the default
-- paginated contacts query used while sync/webhook writes are active.

CREATE TABLE IF NOT EXISTS public.page_sync_leases (
    page_id UUID PRIMARY KEY REFERENCES public.pages(id) ON DELETE CASCADE,
    owner TEXT NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE OR REPLACE FUNCTION public.acquire_page_sync_lease(
    p_page_id UUID,
    p_owner TEXT,
    p_lease_seconds INTEGER DEFAULT 360
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    affected_rows INTEGER;
BEGIN
    IF p_owner IS NULL OR btrim(p_owner) = '' THEN
        RAISE EXCEPTION 'p_owner is required';
    END IF;

    IF p_lease_seconds < 60 OR p_lease_seconds > 900 THEN
        RAISE EXCEPTION 'p_lease_seconds must be between 60 and 900';
    END IF;

    INSERT INTO public.page_sync_leases AS lease (
        page_id,
        owner,
        acquired_at,
        expires_at
    )
    VALUES (
        p_page_id,
        p_owner,
        NOW(),
        NOW() + make_interval(secs => p_lease_seconds)
    )
    ON CONFLICT (page_id) DO UPDATE
    SET owner = EXCLUDED.owner,
        acquired_at = CASE
            WHEN lease.owner = EXCLUDED.owner THEN lease.acquired_at
            ELSE NOW()
        END,
        expires_at = EXCLUDED.expires_at
    WHERE lease.owner = EXCLUDED.owner
       OR lease.expires_at <= NOW();

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    RETURN affected_rows = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_page_sync_lease(
    p_page_id UUID,
    p_owner TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    affected_rows INTEGER;
BEGIN
    DELETE FROM public.page_sync_leases
    WHERE page_id = p_page_id
      AND owner = p_owner;

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    RETURN affected_rows = 1;
END;
$$;

REVOKE ALL ON TABLE public.page_sync_leases FROM PUBLIC;
REVOKE ALL ON FUNCTION public.acquire_page_sync_lease(UUID, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_page_sync_lease(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acquire_page_sync_lease(UUID, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_page_sync_lease(UUID, TEXT) TO service_role;

CREATE INDEX IF NOT EXISTS idx_contacts_page_last_interaction
ON public.contacts (page_id, last_interaction_at DESC NULLS LAST);

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260813_009', 'Prevent overlapping contact syncs and reduce contacts query load')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';


-- <<< END SOURCE: database/migration_contact_sync_load_control.sql

-- >>> SOURCE: database/migration_conversation_export_uuid_fix.sql
-- Repair export claiming on databases where uuid-ossp is installed outside
-- the function's restricted search_path (common on Supabase).

ALTER TABLE public.conversation_export_jobs
    ALTER COLUMN id SET DEFAULT pg_catalog.gen_random_uuid();

CREATE OR REPLACE FUNCTION public.claim_conversation_export_job(p_job_id UUID DEFAULT NULL)
RETURNS SETOF public.conversation_export_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_job_id UUID;
BEGIN
    SELECT job.id
      INTO v_job_id
      FROM public.conversation_export_jobs AS job
     WHERE (p_job_id IS NULL OR job.id = p_job_id)
       AND job.expires_at > NOW()
       AND (
            job.status = 'queued'
            OR (
                job.status = 'running'
                AND (job.claimed_at IS NULL OR job.claimed_at < NOW() - INTERVAL '6 minutes')
            )
       )
       AND (job.next_attempt_at IS NULL OR job.next_attempt_at <= NOW())
     ORDER BY job.created_at ASC
     LIMIT 1
     FOR UPDATE SKIP LOCKED;

    IF v_job_id IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    UPDATE public.conversation_export_jobs AS claimed
       SET status = 'running',
           claim_token = pg_catalog.gen_random_uuid(),
           claimed_at = NOW(),
           started_at = COALESCE(started_at, NOW()),
           error_message = NULL,
           updated_at = NOW()
     WHERE claimed.id = v_job_id
     RETURNING claimed.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_conversation_export_job(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_conversation_export_job(UUID) TO service_role;


-- <<< END SOURCE: database/migration_conversation_export_uuid_fix.sql

-- >>> SOURCE: database/migration_combined_default_page_tag.sql
-- One combined page tag. Reuse existing Paid / Availed Service tags and their
-- contact assignments; never replace a page's existing combined tag.
ALTER TABLE tags
ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

-- Correct the mistaken three-tag rollout on 2026-09-18. These 119 rows were
-- created together and have no contact assignments. The older PAID tag is kept.
DROP TRIGGER IF EXISTS create_default_page_tags_on_insert ON pages;
DROP INDEX IF EXISTS idx_tags_default_page_name;

DELETE FROM tags AS t
WHERE t.is_default
  AND t.owner_type = 'page'
  AND t.page_id = t.owner_id
  AND t.name IN ('Paid', 'Avail Service', 'Qualified')
  AND t.created_at = TIMESTAMPTZ '2026-09-18 17:20:20.910+00'
  AND NOT EXISTS (SELECT 1 FROM contact_tags AS ct WHERE ct.tag_id = t.id);

UPDATE tags
SET is_default = FALSE
WHERE is_default
  AND owner_type = 'page'
  AND lower(btrim(name)) IN ('paid', 'avail service', 'qualified');

WITH existing AS (
    SELECT DISTINCT ON (t.owner_id) t.id
    FROM tags AS t
    JOIN pages AS p ON p.id = t.owner_id
    WHERE t.owner_type = 'page'
      AND regexp_replace(lower(t.name), '[^a-z]', '', 'g')
          IN ('paidavailedservice', 'paidavailedservices')
    ORDER BY t.owner_id, t.created_at NULLS LAST, t.id
)
UPDATE tags
SET is_default = TRUE, page_id = owner_id
WHERE id IN (SELECT id FROM existing);

INSERT INTO tags (name, color, owner_type, owner_id, page_id, is_default)
SELECT 'Paid / Availed Service', '#16a34a', 'page', p.id, p.id, TRUE
FROM pages AS p
WHERE NOT EXISTS (
    SELECT 1 FROM tags AS t
    WHERE t.owner_type = 'page'
      AND t.owner_id = p.id
      AND regexp_replace(lower(t.name), '[^a-z]', '', 'g')
          IN ('paidavailedservice', 'paidavailedservices')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_one_default_per_page
ON tags (owner_id) WHERE owner_type = 'page' AND is_default;

CREATE OR REPLACE FUNCTION create_default_page_tags()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO tags (name, color, owner_type, owner_id, page_id, is_default)
    VALUES ('Paid / Availed Service', '#16a34a', 'page', NEW.id, NEW.id, TRUE);
    RETURN NEW;
END;
$$;

CREATE TRIGGER create_default_page_tags_on_insert
AFTER INSERT ON pages
FOR EACH ROW EXECUTE FUNCTION create_default_page_tags();


-- <<< END SOURCE: database/migration_combined_default_page_tag.sql


-- Final baseline permissions and lookup indexes.
CREATE INDEX IF NOT EXISTS idx_users_email_active
    ON public.users(email) WHERE is_active = TRUE;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
