-- Up Migration
-- Deleting an agent run sets workflow_evaluation_jobs.run_id to NULL, which
-- scans this column without an index.
CREATE INDEX IF NOT EXISTS idx_workflow_evaluation_jobs_run_id
  ON workflow_evaluation_jobs (run_id)
  WHERE run_id IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS idx_workflow_evaluation_jobs_run_id;
