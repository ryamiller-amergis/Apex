CREATE TABLE IF NOT EXISTS test_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prd_id UUID NOT NULL REFERENCES prds(id) ON DELETE CASCADE,
  chat_thread_id UUID REFERENCES chat_threads(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'generating',
  test_cases_json JSONB,
  test_cases_md TEXT,
  coverage_summary JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS test_cases_prd_id_idx ON test_cases(prd_id);

ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS test_case_skill_path TEXT,
  ADD COLUMN IF NOT EXISTS test_case_model TEXT;
