-- Migration: Add Password Authentication
-- Run this in Supabase SQL Editor

-- Add password_hash column to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Add role column (admin or user)
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user';

-- Add is_active column to enable/disable users
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

-- Create index for faster email lookups on login
CREATE INDEX IF NOT EXISTS idx_users_email_active ON users(email) WHERE is_active = true;

-- Administrators must be provisioned explicitly. Never ship a known default
-- password in a production migration.
