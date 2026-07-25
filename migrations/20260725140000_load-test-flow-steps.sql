-- Up Migration: persist guided-form flow steps on load_test so path/method edits round-trip

ALTER TABLE load_test
  ADD COLUMN IF NOT EXISTS flow_steps JSONB;

-- Down Migration

ALTER TABLE load_test
  DROP COLUMN IF EXISTS flow_steps;
