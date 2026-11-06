-- Up Migration

CREATE TABLE IF NOT EXISTS qa_lab_assistant_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  suite_id UUID NOT NULL REFERENCES qa_ado_test_suites(id) ON DELETE CASCADE,
  local_case_id TEXT,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  before_case JSONB,
  after_case JSONB,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_by TEXT,
  decided_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  CONSTRAINT qa_lab_assistant_proposals_kind_check
    CHECK (kind IN ('edit', 'add', 'delete', 'comment', 'regenerate')),
  CONSTRAINT qa_lab_assistant_proposals_status_check
    CHECK (status IN ('pending', 'applied', 'discarded', 'failed'))
);

CREATE INDEX IF NOT EXISTS qa_lab_assistant_proposals_thread_idx
  ON qa_lab_assistant_proposals(thread_id, created_at);

COMMENT ON TABLE qa_lab_assistant_proposals IS
  'A change Ask Apex proposed in QA Lab. Nothing changes until QA confirms it in the chat.';
COMMENT ON COLUMN qa_lab_assistant_proposals.before_case IS
  'The case when the change was proposed; confirming fails if the case has changed since.';

-- Down Migration

DROP TABLE IF EXISTS qa_lab_assistant_proposals;
