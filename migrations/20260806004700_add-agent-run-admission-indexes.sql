-- FEAT-002 / TBI-002 S1: additive admission-support indexes on agent_runs.
-- FEAT-001 owns the lifecycle columns; this migration is index-only.

-- Up Migration

CREATE INDEX IF NOT EXISTS idx_agent_runs_background_in_flight
  ON agent_runs (lane, status)
  WHERE lane = 'background' AND status IN ('dispatched', 'running');

CREATE INDEX IF NOT EXISTS idx_agent_runs_background_fair_queue
  ON agent_runs (project_id, queued_at, id)
  WHERE lane = 'background' AND status = 'queued';

-- Down Migration

DROP INDEX IF EXISTS idx_agent_runs_background_fair_queue;
DROP INDEX IF EXISTS idx_agent_runs_background_in_flight;
