-- Up Migration

CREATE TABLE IF NOT EXISTS qa_case_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  ado_test_case_id INTEGER NOT NULL,
  ado_plan_id INTEGER NOT NULL,
  ado_suite_id INTEGER NOT NULL,
  parent_work_item_id INTEGER,
  status TEXT NOT NULL DEFAULT 'draft',
  outcome TEXT,
  comment TEXT NOT NULL DEFAULT '',
  step_results JSONB NOT NULL DEFAULT '[]'::jsonb,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  bugs JSONB NOT NULL DEFAULT '[]'::jsonb,
  ado_run_id INTEGER,
  ado_result_id INTEGER,
  ado_run_url TEXT,
  published_at TIMESTAMPTZ,
  created_by TEXT,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT qa_case_runs_status_check CHECK (status IN ('draft', 'published')),
  CONSTRAINT qa_case_runs_outcome_check CHECK (outcome IS NULL OR outcome IN ('passed', 'failed')),
  CONSTRAINT qa_case_runs_comment_check CHECK (char_length(comment) <= 4000)
);

CREATE UNIQUE INDEX IF NOT EXISTS qa_case_runs_one_draft_idx
  ON qa_case_runs(project, ado_test_case_id)
  WHERE status = 'draft';

CREATE INDEX IF NOT EXISTS qa_case_runs_case_idx
  ON qa_case_runs(project, ado_test_case_id, created_at);

COMMENT ON TABLE qa_case_runs IS
  'One manual run of an Azure DevOps Test Case from QA Lab. Saved as a draft while QA tests, then published to Azure DevOps as a test run.';

COMMENT ON COLUMN qa_case_runs.attachments IS
  'Files QA attached, already uploaded to the Azure DevOps attachment store. stepId is set for a step attachment.';

-- Down Migration

DROP TABLE IF EXISTS qa_case_runs;
