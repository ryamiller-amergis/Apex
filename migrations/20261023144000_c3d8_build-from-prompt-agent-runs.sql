-- Link agent_runs to a build task (FEAT-001 TBI-001).
-- Nullable column and a wider workflow class. Existing rows are unchanged.
-- The class check is added NOT VALID, then validated, so the lock on this busy table stays short.

-- Up Migration

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS build_task_id UUID;

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS fk_agent_runs_build_task;

ALTER TABLE agent_runs
  ADD CONSTRAINT fk_agent_runs_build_task
  FOREIGN KEY (build_task_id) REFERENCES build_tasks (id) ON DELETE SET NULL;

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_workflow_class_check;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_workflow_class_check
  CHECK (
    workflow_class IS NULL
    OR workflow_class IN ('generation', 'implementation', 'build-task')
  ) NOT VALID;

ALTER TABLE agent_runs VALIDATE CONSTRAINT agent_runs_workflow_class_check;

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_build_task_class_check;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_build_task_class_check
  CHECK (build_task_id IS NULL OR workflow_class = 'build-task') NOT VALID;

ALTER TABLE agent_runs VALIDATE CONSTRAINT agent_runs_build_task_class_check;

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_runs_one_live_per_build_task
  ON agent_runs (build_task_id)
  WHERE workflow_class = 'build-task'
    AND status IN ('queued', 'dispatched', 'running')
    AND build_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_runs_build_task
  ON agent_runs (build_task_id)
  WHERE build_task_id IS NOT NULL;

-- Down Migration

UPDATE agent_runs
SET workflow_class = NULL,
    build_task_id = NULL
WHERE workflow_class = 'build-task'
   OR build_task_id IS NOT NULL;

DROP INDEX IF EXISTS uq_agent_runs_one_live_per_build_task;
DROP INDEX IF EXISTS idx_agent_runs_build_task;

ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_build_task_class_check;
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS fk_agent_runs_build_task;
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_workflow_class_check;

ALTER TABLE agent_runs DROP COLUMN IF EXISTS build_task_id;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_workflow_class_check
  CHECK (
    workflow_class IS NULL
    OR workflow_class IN ('generation', 'implementation')
  );
