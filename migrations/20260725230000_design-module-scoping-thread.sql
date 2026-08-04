-- Up Migration: persistent AI scoping thread per design module

ALTER TABLE design_modules
  ADD COLUMN IF NOT EXISTS scoping_thread_id TEXT;

-- Down Migration

ALTER TABLE design_modules
  DROP COLUMN IF EXISTS scoping_thread_id;
