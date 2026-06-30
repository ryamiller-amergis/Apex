-- Up Migration: Add configurable reminder/deadline timing to standup configs

ALTER TABLE standup_configs
  ADD COLUMN reminder_delay_min integer NOT NULL DEFAULT 30,
  ADD COLUMN reminder_interval_min integer NOT NULL DEFAULT 60,
  ADD COLUMN facilitator_deadline_min integer NOT NULL DEFAULT 120;

ALTER TABLE standup_sessions
  ADD COLUMN last_reminded_at timestamptz;

-- Down Migration
