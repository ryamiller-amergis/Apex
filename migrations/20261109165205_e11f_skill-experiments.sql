-- Up Migration
-- Skill experiments: replay saved cases with the current SKILL.md and a candidate, score both with
-- the blind judge, and record the decision, approval and pull request.
-- skill_learning_settings holds the per-project monthly budget; no row or a NULL budget means
-- experiments are off for that project.

CREATE TABLE IF NOT EXISTS skill_learning_settings (
  project TEXT PRIMARY KEY,
  monthly_budget_usd NUMERIC(10, 2),
  updated_by TEXT REFERENCES app_users(oid) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT skill_learning_settings_budget_check CHECK (monthly_budget_usd IS NULL OR monthly_budget_usd >= 0)
);

CREATE TABLE IF NOT EXISTS skill_experiments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  skill_path TEXT NOT NULL,
  baseline_content TEXT NOT NULL,
  baseline_sha256 TEXT NOT NULL,
  candidate_content TEXT NOT NULL,
  candidate_sha256 TEXT NOT NULL,
  candidate_source TEXT NOT NULL,
  change_notes TEXT,
  definition_id UUID NOT NULL REFERENCES workflow_evaluation_definitions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'running',
  estimated_cost_usd NUMERIC(10, 2) NOT NULL DEFAULT 0,
  spent_usd NUMERIC(10, 2) NOT NULL DEFAULT 0,
  result JSONB,
  approval_playbook_run_id UUID,
  decided_by TEXT REFERENCES app_users(oid) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  pull_request_url TEXT,
  branch_name TEXT,
  promotion_error TEXT,
  created_by TEXT NOT NULL REFERENCES app_users(oid) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT skill_experiments_subject_type_check CHECK (subject_type IN ('prd', 'design_doc')),
  CONSTRAINT skill_experiments_status_check CHECK (status IN (
    'running', 'completed', 'awaiting_approval', 'approved', 'rejected', 'promoted', 'failed', 'cancelled'
  )),
  CONSTRAINT skill_experiments_candidate_source_check CHECK (candidate_source IN ('manual', 'reflective')),
  CONSTRAINT skill_experiments_sha_check CHECK (
    baseline_sha256 ~ '^[0-9a-f]{64}$' AND candidate_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT skill_experiments_distinct_check CHECK (baseline_sha256 <> candidate_sha256),
  CONSTRAINT skill_experiments_cost_check CHECK (estimated_cost_usd >= 0 AND spent_usd >= 0)
);

CREATE INDEX IF NOT EXISTS idx_skill_experiments_project_created
  ON skill_experiments (project, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_experiments_running
  ON skill_experiments (status) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS skill_experiment_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id UUID NOT NULL REFERENCES skill_experiments(id) ON DELETE CASCADE,
  case_key TEXT NOT NULL,
  case_kind TEXT NOT NULL,
  split TEXT NOT NULL,
  arm TEXT NOT NULL,
  subject_id UUID NOT NULL,
  source_run_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  generation_run_id TEXT,
  judge_run_id TEXT,
  output JSONB,
  criteria_scores JSONB,
  overall_score NUMERIC(4, 2),
  judge_summary TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_skill_experiment_runs_case_arm UNIQUE (experiment_id, case_key, arm),
  CONSTRAINT skill_experiment_runs_case_kind_check CHECK (case_kind IN ('failure', 'control')),
  CONSTRAINT skill_experiment_runs_split_check CHECK (split IN ('dev', 'holdout')),
  CONSTRAINT skill_experiment_runs_arm_check CHECK (arm IN ('baseline', 'candidate')),
  CONSTRAINT skill_experiment_runs_status_check CHECK (status IN (
    'pending', 'generating', 'judging', 'scored', 'failed', 'skipped'
  )),
  CONSTRAINT skill_experiment_runs_score_check CHECK (overall_score IS NULL OR overall_score BETWEEN 1 AND 5)
);

CREATE INDEX IF NOT EXISTS idx_skill_experiment_runs_experiment
  ON skill_experiment_runs (experiment_id, status);

-- Down Migration
DROP TABLE IF EXISTS skill_experiment_runs;
DROP TABLE IF EXISTS skill_experiments;
DROP TABLE IF EXISTS skill_learning_settings;
