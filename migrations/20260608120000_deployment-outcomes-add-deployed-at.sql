-- Up Migration
-- Add deployed_at column to deployment_outcomes.
-- This stores the actual deployment date (from the production deployment record or the
-- release epic's target date), so report grouping is based on WHEN the release shipped
-- rather than when the outcome was entered.
ALTER TABLE deployment_outcomes
  ADD COLUMN IF NOT EXISTS deployed_at TIMESTAMPTZ;

-- Down Migration
ALTER TABLE deployment_outcomes
  DROP COLUMN IF EXISTS deployed_at;
