-- Build agent launch snapshot (FEAT-009 TBI-017).
-- Additive nullable column holding the frozen launch input for one build task
-- attempt. Written once before the Cursor call and never changed after.
-- The one-live-run-per-build-task index already exists (uq_agent_runs_one_live_per_build_task).

-- Up Migration

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS build_launch_snapshot JSONB;

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_build_launch_snapshot_task_check;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_build_launch_snapshot_task_check
    CHECK (build_launch_snapshot IS NULL OR build_task_id IS NOT NULL);

CREATE OR REPLACE FUNCTION agent_runs_build_launch_snapshot_immutable()
RETURNS trigger AS $$
BEGIN
  IF OLD.build_launch_snapshot IS NOT NULL
     AND NEW.build_launch_snapshot IS DISTINCT FROM OLD.build_launch_snapshot THEN
    RAISE EXCEPTION 'build_launch_snapshot is write-once'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_runs_build_launch_snapshot_immutable ON agent_runs;

CREATE TRIGGER agent_runs_build_launch_snapshot_immutable
BEFORE UPDATE ON agent_runs
FOR EACH ROW
EXECUTE PROCEDURE agent_runs_build_launch_snapshot_immutable();

-- Down Migration

DROP TRIGGER IF EXISTS agent_runs_build_launch_snapshot_immutable ON agent_runs;
DROP FUNCTION IF EXISTS agent_runs_build_launch_snapshot_immutable();

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_build_launch_snapshot_task_check;

ALTER TABLE agent_runs
  DROP COLUMN IF EXISTS build_launch_snapshot;
