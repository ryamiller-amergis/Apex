-- Up Migration

-- Runs now belong to a QA Lab case, so QA can test before the case is in Azure DevOps.
-- The table only existed on the unreleased QA Lab test-runs branch; earlier drafts have no case to belong to.
DELETE FROM qa_case_runs;

DROP INDEX IF EXISTS qa_case_runs_one_draft_idx;
DROP INDEX IF EXISTS qa_case_runs_case_idx;

ALTER TABLE qa_case_runs
  ADD COLUMN suite_id UUID NOT NULL REFERENCES qa_ado_test_suites(id) ON DELETE CASCADE,
  ADD COLUMN local_case_id TEXT NOT NULL,
  ALTER COLUMN ado_test_case_id DROP NOT NULL,
  ALTER COLUMN ado_plan_id DROP NOT NULL,
  ALTER COLUMN ado_suite_id DROP NOT NULL,
  DROP COLUMN attachments;

CREATE UNIQUE INDEX qa_case_runs_one_draft_idx
  ON qa_case_runs(suite_id, local_case_id)
  WHERE status = 'draft';

CREATE INDEX qa_case_runs_case_idx
  ON qa_case_runs(suite_id, local_case_id, created_at);

COMMENT ON TABLE qa_case_runs IS
  'One manual run of a QA Lab case. Saved in Apex while QA tests, then published to Azure DevOps as a test run.';

CREATE TABLE qa_case_run_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES qa_case_runs(id) ON DELETE CASCADE,
  step_order INTEGER,
  file_name TEXT NOT NULL,
  content_type TEXT,
  size INTEGER NOT NULL,
  content BYTEA NOT NULL,
  ado_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX qa_case_run_files_run_idx ON qa_case_run_files(run_id, created_at);

COMMENT ON TABLE qa_case_run_files IS
  'Files QA attached to a run. Kept in Apex and uploaded to Azure DevOps when a Bug is filed or the run is published.';
COMMENT ON COLUMN qa_case_run_files.ado_url IS
  'The Azure DevOps work item attachment URL, once uploaded, so the file is uploaded only once.';

-- Down Migration

DROP TABLE IF EXISTS qa_case_run_files;

DELETE FROM qa_case_runs;
DROP INDEX IF EXISTS qa_case_runs_one_draft_idx;
DROP INDEX IF EXISTS qa_case_runs_case_idx;

ALTER TABLE qa_case_runs
  DROP COLUMN IF EXISTS suite_id,
  DROP COLUMN IF EXISTS local_case_id,
  ALTER COLUMN ado_test_case_id SET NOT NULL,
  ALTER COLUMN ado_plan_id SET NOT NULL,
  ALTER COLUMN ado_suite_id SET NOT NULL,
  ADD COLUMN attachments JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE UNIQUE INDEX qa_case_runs_one_draft_idx
  ON qa_case_runs(project, ado_test_case_id)
  WHERE status = 'draft';

CREATE INDEX qa_case_runs_case_idx
  ON qa_case_runs(project, ado_test_case_id, created_at);
