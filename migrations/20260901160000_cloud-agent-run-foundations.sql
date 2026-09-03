-- Cloud Agent run foundations (My Work FEAT-001).
-- Additive nullable columns, write-once identity trigger, one-live-run
-- partial unique index, and a disabled my-work-cloud-agent flag seed.
-- Cleanup: retain the enabled branch after two stable sprints at full rollout.

-- Up Migration

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_lane_check;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_lane_check
    CHECK (
      lane IS NULL
      OR lane IN ('background', 'ai-runs-interactive', 'cloud-agent')
    );

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_terminal_reason_check;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_terminal_reason_check
    CHECK (
      terminal_reason IS NULL
      OR terminal_reason IN (
        'worker_lost',
        'progress_timeout',
        'queue_ttl',
        'forced_cancel',
        'cloud_agent_timeout'
      )
    );

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS dev_session_id UUID REFERENCES dev_sessions(id) ON DELETE SET NULL;

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS workflow_class TEXT;

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS cloud_agent_identity TEXT;

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS cloud_agent_managed BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_workflow_class_check;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_workflow_class_check
    CHECK (
      workflow_class IS NULL
      OR workflow_class IN ('generation', 'implementation')
    );

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_cloud_agent_managed_identity_check;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_cloud_agent_managed_identity_check
    CHECK (cloud_agent_managed = FALSE OR cloud_agent_identity IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_runs_one_live_per_session
  ON agent_runs (dev_session_id)
  WHERE workflow_class = 'implementation'
    AND status IN ('queued', 'dispatched', 'running')
    AND dev_session_id IS NOT NULL;

CREATE OR REPLACE FUNCTION agent_runs_cloud_agent_identity_immutable()
RETURNS trigger AS $$
BEGIN
  IF OLD.cloud_agent_identity IS NOT NULL
     AND NEW.cloud_agent_identity IS DISTINCT FROM OLD.cloud_agent_identity THEN
    RAISE EXCEPTION 'cloud_agent_identity is write-once'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_runs_cloud_agent_identity_immutable ON agent_runs;

CREATE TRIGGER agent_runs_cloud_agent_identity_immutable
BEFORE UPDATE ON agent_runs
FOR EACH ROW
EXECUTE PROCEDURE agent_runs_cloud_agent_identity_immutable();

ALTER TABLE dev_sessions
  ADD COLUMN IF NOT EXISTS current_run_id TEXT;

ALTER TABLE dev_sessions
  ADD COLUMN IF NOT EXISTS current_run_pr_url TEXT;

ALTER TABLE dev_sessions
  ADD COLUMN IF NOT EXISTS current_run_pr_status TEXT;

ALTER TABLE dev_sessions
  DROP CONSTRAINT IF EXISTS dev_sessions_current_run_pr_status_check;

ALTER TABLE dev_sessions
  ADD CONSTRAINT dev_sessions_current_run_pr_status_check
    CHECK (
      current_run_pr_status IS NULL
      OR current_run_pr_status IN ('none', 'open', 'merged')
    );

ALTER TABLE dev_sessions
  ALTER COLUMN current_run_pr_status SET DEFAULT 'none';

INSERT INTO feature_flags (
  key,
  description,
  enabled,
  lifecycle,
  cleanup_ready,
  created_by
)
VALUES (
  'my-work-cloud-agent',
  'Gates Start Cloud Development on Azure DevOps My Work rows. Off keeps local Start Development / Resume / Close only.',
  false,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

-- Down Migration

DELETE FROM feature_flags WHERE key = 'my-work-cloud-agent';

ALTER TABLE dev_sessions
  DROP CONSTRAINT IF EXISTS dev_sessions_current_run_pr_status_check;

ALTER TABLE dev_sessions
  DROP COLUMN IF EXISTS current_run_pr_status;

ALTER TABLE dev_sessions
  DROP COLUMN IF EXISTS current_run_pr_url;

ALTER TABLE dev_sessions
  DROP COLUMN IF EXISTS current_run_id;

DROP TRIGGER IF EXISTS agent_runs_cloud_agent_identity_immutable ON agent_runs;
DROP FUNCTION IF EXISTS agent_runs_cloud_agent_identity_immutable();

DROP INDEX IF EXISTS uq_agent_runs_one_live_per_session;

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_cloud_agent_managed_identity_check;

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_workflow_class_check;

ALTER TABLE agent_runs
  DROP COLUMN IF EXISTS cloud_agent_managed;

ALTER TABLE agent_runs
  DROP COLUMN IF EXISTS cloud_agent_identity;

ALTER TABLE agent_runs
  DROP COLUMN IF EXISTS workflow_class;

ALTER TABLE agent_runs
  DROP COLUMN IF EXISTS dev_session_id;

UPDATE agent_runs
SET lane = NULL
WHERE lane = 'cloud-agent';

UPDATE agent_runs
SET terminal_reason = NULL
WHERE terminal_reason = 'cloud_agent_timeout';

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_terminal_reason_check;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_terminal_reason_check
    CHECK (
      terminal_reason IS NULL
      OR terminal_reason IN ('worker_lost', 'progress_timeout', 'queue_ttl', 'forced_cancel')
    );

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_lane_check;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_lane_check
    CHECK (
      lane IS NULL
      OR lane IN ('background', 'ai-runs-interactive')
    );
