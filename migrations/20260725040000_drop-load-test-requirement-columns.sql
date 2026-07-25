-- Up Migration: drop unused requirement linkage from load tests

ALTER TABLE load_test
  DROP COLUMN IF EXISTS requirement_ref;

ALTER TABLE load_test_run
  DROP COLUMN IF EXISTS requirement_activity_posted_at,
  DROP COLUMN IF EXISTS requirement_activity_external_id;

-- Down Migration

ALTER TABLE load_test
  ADD COLUMN IF NOT EXISTS requirement_ref JSONB;

ALTER TABLE load_test_run
  ADD COLUMN IF NOT EXISTS requirement_activity_external_id TEXT,
  ADD COLUMN IF NOT EXISTS requirement_activity_posted_at TIMESTAMPTZ;
