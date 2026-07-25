-- Up Migration: FEAT-010 — idempotent requirement activity columns on load_test_run

ALTER TABLE load_test_run
  ADD COLUMN IF NOT EXISTS requirement_activity_external_id TEXT,
  ADD COLUMN IF NOT EXISTS requirement_activity_posted_at TIMESTAMPTZ;

---- DOWN ----

ALTER TABLE load_test_run
  DROP COLUMN IF EXISTS requirement_activity_posted_at,
  DROP COLUMN IF EXISTS requirement_activity_external_id;
