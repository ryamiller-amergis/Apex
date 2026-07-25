-- Up Migration: per-interview snapshot of prototype-stage and test-case workflow flags

ALTER TABLE interviews
  ADD COLUMN IF NOT EXISTS prototype_stage_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS test_cases_enabled BOOLEAN NOT NULL DEFAULT true;

-- Down Migration

ALTER TABLE interviews
  DROP COLUMN IF EXISTS test_cases_enabled,
  DROP COLUMN IF EXISTS prototype_stage_enabled;
