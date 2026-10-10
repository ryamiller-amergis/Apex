-- Up

CREATE TABLE IF NOT EXISTS qa_ado_test_suites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  root_work_item_id INTEGER NOT NULL,
  root_work_item_type TEXT NOT NULL,
  root_title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'generating',
  chat_thread_id UUID REFERENCES chat_threads(id) ON DELETE SET NULL,
  source_snapshot JSONB NOT NULL,
  test_cases_json JSONB,
  test_cases_md TEXT,
  coverage_summary JSONB,
  published_cases JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT qa_ado_test_suites_status_check
    CHECK (status IN ('generating', 'ready', 'failed'))
);

CREATE INDEX IF NOT EXISTS qa_ado_test_suites_project_root_idx
  ON qa_ado_test_suites(project, root_work_item_id, created_at);

CREATE INDEX IF NOT EXISTS qa_ado_test_suites_status_idx
  ON qa_ado_test_suites(status);

COMMENT ON TABLE qa_ado_test_suites IS
  'Retained QA suites generated from Azure DevOps work items outside Apex PRDs.';

COMMENT ON COLUMN qa_ado_test_suites.published_cases IS
  'Idempotency ledger mapping local generated case ids to linked ADO Test Case work items.';

-- Down
-- DROP TABLE IF EXISTS qa_ado_test_suites;
