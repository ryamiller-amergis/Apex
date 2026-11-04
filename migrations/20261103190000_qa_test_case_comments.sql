-- Up

CREATE TABLE IF NOT EXISTS qa_case_regenerations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  suite_id UUID NOT NULL REFERENCES qa_ado_test_suites(id) ON DELETE CASCADE,
  local_case_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'generating',
  chat_thread_id UUID REFERENCES chat_threads(id) ON DELETE SET NULL,
  previous_case JSONB NOT NULL,
  error TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT qa_case_regenerations_status_check
    CHECK (status IN ('generating', 'ready', 'failed', 'restored'))
);

CREATE INDEX IF NOT EXISTS qa_case_regenerations_suite_case_idx
  ON qa_case_regenerations(suite_id, local_case_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS qa_case_regenerations_one_generating_idx
  ON qa_case_regenerations(suite_id, local_case_id)
  WHERE status = 'generating';

CREATE INDEX IF NOT EXISTS qa_case_regenerations_thread_idx
  ON qa_case_regenerations(chat_thread_id);

COMMENT ON TABLE qa_case_regenerations IS
  'One agent run that rewrote a single generated QA case from reviewer comments.';

COMMENT ON COLUMN qa_case_regenerations.previous_case IS
  'The case as it was before the run, so QA can restore it.';

CREATE TABLE IF NOT EXISTS qa_case_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  suite_id UUID NOT NULL REFERENCES qa_ado_test_suites(id) ON DELETE CASCADE,
  local_case_id TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  regeneration_id UUID REFERENCES qa_case_regenerations(id) ON DELETE SET NULL,
  author_id TEXT NOT NULL,
  author_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT qa_case_comments_status_check
    CHECK (status IN ('open', 'addressed')),
  CONSTRAINT qa_case_comments_body_check
    CHECK (char_length(btrim(body)) BETWEEN 1 AND 4000)
);

CREATE INDEX IF NOT EXISTS qa_case_comments_suite_case_idx
  ON qa_case_comments(suite_id, local_case_id, created_at);

COMMENT ON TABLE qa_case_comments IS
  'Reviewer comments on one generated QA case. A regeneration marks the comments it used as addressed.';

-- Down
-- DROP TABLE IF EXISTS qa_case_comments;
-- DROP TABLE IF EXISTS qa_case_regenerations;
