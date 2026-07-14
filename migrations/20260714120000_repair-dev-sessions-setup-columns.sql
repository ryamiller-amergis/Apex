-- Up Migration
-- Repair: 20260714100000 was recorded as applied but these columns are missing
-- on some environments, which breaks Apex (prd/feature) session inserts.

ALTER TABLE dev_sessions
  ADD COLUMN IF NOT EXISTS setup_phase TEXT,
  ADD COLUMN IF NOT EXISTS setup_detail TEXT,
  ADD COLUMN IF NOT EXISTS setup_progress_at TIMESTAMPTZ;

-- Down Migration

ALTER TABLE dev_sessions
  DROP COLUMN IF EXISTS setup_progress_at,
  DROP COLUMN IF EXISTS setup_detail,
  DROP COLUMN IF EXISTS setup_phase;
