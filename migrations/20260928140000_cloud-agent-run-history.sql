-- Preserve each Cloud Agent run's user-facing job, branch, and pull-request outcome.

-- Up Migration

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS cloud_job_name TEXT,
  ADD COLUMN IF NOT EXISTS cloud_job_execution_name TEXT,
  ADD COLUMN IF NOT EXISTS cloud_branch_name TEXT,
  ADD COLUMN IF NOT EXISTS cloud_pr_url TEXT,
  ADD COLUMN IF NOT EXISTS cloud_pr_status TEXT DEFAULT 'none';

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_cloud_pr_status_check;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_cloud_pr_status_check
    CHECK (
      cloud_pr_status IS NULL
      OR cloud_pr_status IN ('none', 'open', 'abandoned', 'merged')
    );

UPDATE agent_runs AS run
SET
  cloud_job_execution_name = COALESCE(run.cloud_job_execution_name, run.dispatch_message_id),
  cloud_branch_name = COALESCE(run.cloud_branch_name, session.branch_name),
  cloud_pr_url = COALESCE(run.cloud_pr_url, session.current_run_pr_url),
  cloud_pr_status = COALESCE(session.current_run_pr_status, run.cloud_pr_status, 'none')
FROM dev_sessions AS session
WHERE session.current_run_id = run.id;

ALTER TABLE dev_sessions
  DROP CONSTRAINT IF EXISTS dev_sessions_current_run_pr_status_check;

ALTER TABLE dev_sessions
  ADD CONSTRAINT dev_sessions_current_run_pr_status_check
    CHECK (
      current_run_pr_status IS NULL
      OR current_run_pr_status IN ('none', 'open', 'abandoned', 'merged')
    );

-- Down Migration

UPDATE dev_sessions
SET current_run_pr_status = 'open'
WHERE current_run_pr_status = 'abandoned';

ALTER TABLE dev_sessions
  DROP CONSTRAINT IF EXISTS dev_sessions_current_run_pr_status_check;

ALTER TABLE dev_sessions
  ADD CONSTRAINT dev_sessions_current_run_pr_status_check
    CHECK (
      current_run_pr_status IS NULL
      OR current_run_pr_status IN ('none', 'open', 'merged')
    );

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_cloud_pr_status_check;

ALTER TABLE agent_runs
  DROP COLUMN IF EXISTS cloud_pr_status,
  DROP COLUMN IF EXISTS cloud_pr_url,
  DROP COLUMN IF EXISTS cloud_branch_name,
  DROP COLUMN IF EXISTS cloud_job_execution_name,
  DROP COLUMN IF EXISTS cloud_job_name;
