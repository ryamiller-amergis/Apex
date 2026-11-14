-- Up Migration
-- Separate migration so environments that already applied the initial
-- 20261113120000_standup-delivery-pulse migration receive roster_mode.
ALTER TABLE standup_configs
  ADD COLUMN IF NOT EXISTS roster_mode TEXT NOT NULL DEFAULT 'ado_and_groups';

-- Down Migration
ALTER TABLE standup_configs
  DROP COLUMN IF EXISTS roster_mode;
