-- Up Migration

-- Persist whether a run was claimed under event-driven-run-termination so the
-- reaper can classify deterministically from the row. Event-driven runs never
-- write a heartbeat by design; without this marker a transient flag-eval miss
-- in the reaper falls into the legacy branch and mislabels a healthy run as
-- "Worker lost (heartbeat expired)".
ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS event_driven BOOLEAN NOT NULL DEFAULT FALSE;

-- Down Migration

-- ALTER TABLE agent_runs DROP COLUMN IF EXISTS event_driven;
