-- Up Migration
-- Meaning checks suggested by a worker run that reads reviewer corrections for one stage.
-- A person accepts or dismisses each; accepted ones join the stage's Promptfoo suite as
-- llm-rubric tests for that project.

CREATE TABLE IF NOT EXISTS skill_check_mining_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  agent_run_id TEXT,
  corrections INTEGER NOT NULL,
  proposals INTEGER,
  error TEXT,
  estimated_cost_usd NUMERIC(10, 2) NOT NULL,
  requested_by TEXT REFERENCES app_users(oid) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT skill_check_mining_runs_status_check CHECK (status IN ('running', 'completed', 'failed')),
  CONSTRAINT skill_check_mining_runs_counts_check CHECK (corrections >= 0 AND (proposals IS NULL OR proposals >= 0))
);

CREATE INDEX IF NOT EXISTS idx_skill_check_mining_runs_project
  ON skill_check_mining_runs (project, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_check_mining_runs_running
  ON skill_check_mining_runs (project, stage_key) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS skill_semantic_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  statement TEXT NOT NULL,
  rationale TEXT,
  support INTEGER NOT NULL,
  evidence_event_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'proposed',
  mining_run_id UUID REFERENCES skill_check_mining_runs(id) ON DELETE SET NULL,
  decided_by TEXT REFERENCES app_users(oid) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT skill_semantic_checks_status_check CHECK (status IN ('proposed', 'accepted', 'dismissed')),
  CONSTRAINT skill_semantic_checks_statement_check CHECK (length(statement) BETWEEN 1 AND 300),
  CONSTRAINT skill_semantic_checks_support_check CHECK (support >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_semantic_checks_statement
  ON skill_semantic_checks (project, stage_key, md5(lower(statement)));
CREATE INDEX IF NOT EXISTS idx_skill_semantic_checks_accepted
  ON skill_semantic_checks (project, stage_key) WHERE status = 'accepted';

-- Down Migration
DROP TABLE IF EXISTS skill_semantic_checks;
DROP TABLE IF EXISTS skill_check_mining_runs;
