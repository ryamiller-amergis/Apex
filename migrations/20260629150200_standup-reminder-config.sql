-- Up Migration: Add configurable reminder/deadline timing to standup configs
-- Uses IF NOT EXISTS so re-runs succeed when columns were applied under the
-- previous migration filename (1782825153814_standup-reminder-config).

ALTER TABLE standup_configs
  ADD COLUMN IF NOT EXISTS reminder_delay_min integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS reminder_interval_min integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS facilitator_deadline_min integer NOT NULL DEFAULT 120;

ALTER TABLE standup_sessions
  ADD COLUMN IF NOT EXISTS last_reminded_at timestamptz;
