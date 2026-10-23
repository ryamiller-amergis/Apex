-- Up Migration
-- Human workflow evaluation storage (FEAT-001).
-- Definitions are platform rubric versions. Events are append-only human
-- submissions. Jobs are one mutable diagnostic row per event and evaluator.
-- No columns are added to prds or interviews.
-- skill_version is nullable text. FEAT-003 writes the grounded checkout SHA
-- (apex-grounded-sha) when it can resolve one. A missing value must not drop
-- the reviewer's feedback.

CREATE TABLE workflow_evaluation_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  process_key TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  evaluator_key TEXT NOT NULL,
  benchmark_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  rubric JSONB NOT NULL,
  promptfoo_suite_ref TEXT NOT NULL,
  judge_output_schema JSONB NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workflow_evaluation_definitions_version_check CHECK (version >= 1),
  CONSTRAINT workflow_evaluation_definitions_suite_ref_check CHECK (length(btrim(promptfoo_suite_ref)) > 0),
  CONSTRAINT uq_workflow_evaluation_definitions_version UNIQUE (process_key, stage_key, evaluator_key, benchmark_key, version)
);

CREATE UNIQUE INDEX uq_workflow_evaluation_definitions_one_active
  ON workflow_evaluation_definitions (process_key, stage_key, evaluator_key, benchmark_key)
  WHERE active;

CREATE OR REPLACE FUNCTION workflow_evaluation_definitions_active_only()
RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.process_key IS DISTINCT FROM OLD.process_key
     OR NEW.stage_key IS DISTINCT FROM OLD.stage_key
     OR NEW.evaluator_key IS DISTINCT FROM OLD.evaluator_key
     OR NEW.benchmark_key IS DISTINCT FROM OLD.benchmark_key
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.rubric IS DISTINCT FROM OLD.rubric
     OR NEW.promptfoo_suite_ref IS DISTINCT FROM OLD.promptfoo_suite_ref
     OR NEW.judge_output_schema IS DISTINCT FROM OLD.judge_output_schema
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'workflow_evaluation_definitions rows are immutable except for active'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_evaluation_definitions_active_only ON workflow_evaluation_definitions;

CREATE TRIGGER workflow_evaluation_definitions_active_only
BEFORE UPDATE ON workflow_evaluation_definitions
FOR EACH ROW
EXECUTE PROCEDURE workflow_evaluation_definitions_active_only();

CREATE TABLE workflow_evaluation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  definition_id UUID NOT NULL REFERENCES workflow_evaluation_definitions (id) ON DELETE RESTRICT,
  subject_type TEXT NOT NULL,
  subject_id UUID NOT NULL,
  stage_key TEXT NOT NULL,
  phase_index SMALLINT,
  reviewer_user_id TEXT NOT NULL REFERENCES app_users (oid) ON DELETE RESTRICT,
  reviewer_role_key TEXT NOT NULL,
  reviewer_role_label TEXT NOT NULL,
  skill_path TEXT,
  skill_version TEXT,
  model TEXT,
  interview_id UUID,
  prd_id UUID,
  artifact_hash TEXT NOT NULL,
  criteria_scores JSONB NOT NULL,
  outcome TEXT NOT NULL,
  reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  comment TEXT,
  corrected_artifact_text TEXT,
  corrected_artifact_blob_ref JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workflow_evaluation_events_subject_type_check CHECK (
    subject_type IN ('interview_phase', 'prd')
  ),
  CONSTRAINT workflow_evaluation_events_outcome_check CHECK (
    outcome IN ('accept_unchanged', 'accept_after_edits', 'regenerate', 'reject')
  ),
  CONSTRAINT workflow_evaluation_events_subject_coherence_check CHECK (
    (
      subject_type = 'prd'
      AND phase_index IS NULL
      AND prd_id = subject_id
    )
    OR (
      subject_type = 'interview_phase'
      AND phase_index BETWEEN 1 AND 3
      AND interview_id = subject_id
    )
  ),
  CONSTRAINT workflow_evaluation_events_artifact_hash_check CHECK (
    artifact_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT workflow_evaluation_events_role_not_blank_check CHECK (
    length(btrim(reviewer_role_key)) > 0
    AND length(btrim(reviewer_role_label)) > 0
  ),
  CONSTRAINT workflow_evaluation_events_correction_check CHECK (
    corrected_artifact_text IS NULL OR corrected_artifact_blob_ref IS NULL
  ),
  CONSTRAINT workflow_evaluation_events_criteria_scores_check CHECK (
    jsonb_typeof(criteria_scores) = 'object'
  ),
  CONSTRAINT workflow_evaluation_events_reason_codes_check CHECK (
    jsonb_typeof(reason_codes) = 'array'
  )
);

CREATE INDEX idx_workflow_evaluation_events_subject_history
  ON workflow_evaluation_events (project, subject_type, subject_id, created_at DESC);

CREATE INDEX idx_workflow_evaluation_events_artifact
  ON workflow_evaluation_events (project, subject_type, subject_id, artifact_hash);

CREATE INDEX idx_workflow_evaluation_events_project_created
  ON workflow_evaluation_events (project, created_at DESC);

CREATE INDEX idx_workflow_evaluation_events_lineage
  ON workflow_evaluation_events (skill_path, skill_version);

CREATE INDEX idx_workflow_evaluation_events_model
  ON workflow_evaluation_events (model);

CREATE INDEX idx_workflow_evaluation_events_interview
  ON workflow_evaluation_events (interview_id)
  WHERE interview_id IS NOT NULL;

CREATE INDEX idx_workflow_evaluation_events_prd
  ON workflow_evaluation_events (prd_id)
  WHERE prd_id IS NOT NULL;

CREATE OR REPLACE FUNCTION workflow_evaluation_events_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'workflow_evaluation_events rows are immutable'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_evaluation_events_immutable ON workflow_evaluation_events;

CREATE TRIGGER workflow_evaluation_events_immutable
BEFORE UPDATE OR DELETE ON workflow_evaluation_events
FOR EACH ROW
EXECUTE PROCEDURE workflow_evaluation_events_immutable();

CREATE TABLE workflow_evaluation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES workflow_evaluation_events (id) ON DELETE RESTRICT,
  evaluator_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  run_id TEXT REFERENCES agent_runs (id) ON DELETE SET NULL,
  specification_hash TEXT,
  summary JSONB,
  result_blob_refs JSONB,
  error_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workflow_evaluation_jobs_evaluator_check CHECK (
    evaluator_key IN ('promptfoo', 'llm_judge')
  ),
  CONSTRAINT workflow_evaluation_jobs_status_check CHECK (
    status IN ('pending', 'running', 'ready', 'failed')
  ),
  CONSTRAINT uq_workflow_evaluation_jobs_event_evaluator UNIQUE (event_id, evaluator_key)
);

CREATE INDEX idx_workflow_evaluation_jobs_open
  ON workflow_evaluation_jobs (status)
  WHERE status IN ('pending', 'running');

-- Down Migration

DROP TABLE IF EXISTS workflow_evaluation_jobs;

DROP TRIGGER IF EXISTS workflow_evaluation_events_immutable ON workflow_evaluation_events;
DROP FUNCTION IF EXISTS workflow_evaluation_events_immutable();
DROP TABLE IF EXISTS workflow_evaluation_events;

DROP TRIGGER IF EXISTS workflow_evaluation_definitions_active_only ON workflow_evaluation_definitions;
DROP FUNCTION IF EXISTS workflow_evaluation_definitions_active_only();
DROP TABLE IF EXISTS workflow_evaluation_definitions;
