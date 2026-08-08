-- FEAT-007 / TBI-010: allow interactive actor runs in the formal run lifecycle.
-- Phase 1 constrained agent_runs.lane to the background worker lane only.
-- Phase 2 dispatches admitted chat turns with lane = 'ai-runs-interactive'.

-- Up Migration

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_lane_check;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_lane_check
    CHECK (
      lane IS NULL
      OR lane IN ('background', 'ai-runs-interactive')
    );

-- Down Migration

-- Interactive runs cannot satisfy the Phase 1-only constraint. Preserve the
-- run records while clearing only their Phase 2 lane classification.
UPDATE agent_runs
SET lane = NULL
WHERE lane = 'ai-runs-interactive';

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_lane_check;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_lane_check
    CHECK (lane IS NULL OR lane = 'background');
