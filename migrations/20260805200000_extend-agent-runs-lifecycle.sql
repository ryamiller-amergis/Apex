-- FEAT-001 / TBI-001: additive Formal Agent Run Lifecycle fields on agent_runs.
-- Backward compatible: all new columns nullable/defaulted; no legacy backfill.
-- BR-001: no separate queue table.

-- Up Migration

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS project_id TEXT,
  ADD COLUMN IF NOT EXISTS lane TEXT,
  ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispatch_message_id TEXT,
  ADD COLUMN IF NOT EXISTS execution_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cancel_state TEXT,
  ADD COLUMN IF NOT EXISTS terminal_reason TEXT;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_lane_check
    CHECK (lane IS NULL OR lane = 'background'),
  ADD CONSTRAINT agent_runs_terminal_reason_check
    CHECK (
      terminal_reason IS NULL
      OR terminal_reason IN ('worker_lost', 'progress_timeout', 'queue_ttl', 'forced_cancel')
    );

-- Lifecycle / admission / reaper indexes (partial where worker-aware).
CREATE INDEX IF NOT EXISTS idx_agent_runs_status_lane
  ON agent_runs (status, lane);

CREATE INDEX IF NOT EXISTS idx_agent_runs_project_status
  ON agent_runs (project_id, status);

CREATE INDEX IF NOT EXISTS idx_agent_runs_queued_at_worker
  ON agent_runs (queued_at)
  WHERE lane = 'background';

CREATE INDEX IF NOT EXISTS idx_agent_runs_dispatched_at_worker
  ON agent_runs (dispatched_at)
  WHERE lane = 'background' AND dispatch_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_runs_heartbeat_at_worker
  ON agent_runs (heartbeat_at)
  WHERE lane = 'background' AND dispatch_message_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_agent_runs_heartbeat_at_worker;
DROP INDEX IF EXISTS idx_agent_runs_dispatched_at_worker;
DROP INDEX IF EXISTS idx_agent_runs_queued_at_worker;
DROP INDEX IF EXISTS idx_agent_runs_project_status;
DROP INDEX IF EXISTS idx_agent_runs_status_lane;

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_terminal_reason_check,
  DROP CONSTRAINT IF EXISTS agent_runs_lane_check;

ALTER TABLE agent_runs
  DROP COLUMN IF EXISTS terminal_reason,
  DROP COLUMN IF EXISTS cancel_state,
  DROP COLUMN IF EXISTS cancel_requested,
  DROP COLUMN IF EXISTS execution_snapshot,
  DROP COLUMN IF EXISTS dispatch_message_id,
  DROP COLUMN IF EXISTS dispatched_at,
  DROP COLUMN IF EXISTS queued_at,
  DROP COLUMN IF EXISTS lane,
  DROP COLUMN IF EXISTS project_id;
