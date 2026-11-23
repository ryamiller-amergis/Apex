-- Up Migration
-- Counts how often a queued incident analysis failed to start (repository pin or
-- admission), so a row that never starts stops taking one of the sweep's slots.

ALTER TABLE incident_triage_analyses
  ADD COLUMN IF NOT EXISTS admission_attempts INTEGER NOT NULL DEFAULT 0;

-- Down Migration

ALTER TABLE incident_triage_analyses
  DROP COLUMN IF EXISTS admission_attempts;
