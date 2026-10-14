-- Up Migration: playbook_step_runs (TBI-013)
--
-- One row per step execution within a run. Together with playbook_runs this is the whole of what
-- Apex needs to reconstruct a run without the engine's store.
--
-- `failed_retryable` appears in the step vocabulary but not the run vocabulary: it is what a live
-- agent step becomes when the process dies mid-turn. Cursor work cannot resume mid-turn, so the step
-- is parked for a person to retry rather than failing the whole run or being retried automatically.

CREATE TABLE playbook_step_runs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID        NOT NULL REFERENCES playbook_runs(id) ON DELETE CASCADE,
  -- The node id within the pinned version's graph, not a foreign key: the graph is jsonb.
  step_id         TEXT        NOT NULL,
  step_type       TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'running', 'suspended', 'completed',
                                                  'failed', 'failed_retryable', 'cancelled',
                                                  'expired')),
  -- Nullable because approval-gate and notify steps correlate to no agent run. A non-null column
  -- would force a sentinel value, and sentinels get joined against by accident.
  agent_run_id    TEXT        REFERENCES agent_runs(id) ON DELETE SET NULL,
  resume_token    TEXT,
  -- Phase 0 writes output_inline only; the seeded demo definitions produce tiny synthetic outputs.
  -- output_blob_ref is shaped now ({ container, key }, matching ArtifactRef used by load tests) so
  -- fixing the size threshold in Phase 1 costs no migration.
  output_inline   JSONB,
  output_blob_ref JSONB,
  -- Every suspension has a deadline; reconciliation ends the run as expired once it passes.
  expires_at      TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_playbook_step_runs_run_step UNIQUE (run_id, step_id)
);

-- Loading a run with its steps in order — the projection's only query shape.
CREATE INDEX idx_playbook_step_runs_run
  ON playbook_step_runs (run_id, created_at);

-- The reconciliation sweep's index. Partial over open statuses so a pass costs time proportional to
-- outstanding suspensions rather than to all run history, which is what TBI-021's NFR requires and
-- what TBI-013's EXPLAIN check exists to prove.
CREATE INDEX idx_playbook_step_runs_expires_at
  ON playbook_step_runs (expires_at)
  WHERE expires_at IS NOT NULL AND status IN ('pending', 'running', 'suspended');

-- Resuming from a terminal agent-run event looks the step up by its correlation.
CREATE INDEX idx_playbook_step_runs_agent_run
  ON playbook_step_runs (agent_run_id)
  WHERE agent_run_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_playbook_step_runs_agent_run;
DROP INDEX IF EXISTS idx_playbook_step_runs_expires_at;
DROP INDEX IF EXISTS idx_playbook_step_runs_run;
DROP TABLE IF EXISTS playbook_step_runs;
