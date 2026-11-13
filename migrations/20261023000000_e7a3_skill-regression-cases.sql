-- Up Migration
-- Regression cases for monthly skill improvement. One row per human review
-- that scored a criterion at or below the rubric's low-score threshold, or
-- accepted the artifact after edits with corrected text. The review row keeps
-- the scores, comment and corrected text; this row adds a full copy of the
-- reviewed document (only when it still matched the review's hash at capture
-- time) and an admin retire flag. Retired cases stay out of the monthly review.

CREATE TABLE skill_regression_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  event_id UUID NOT NULL REFERENCES workflow_evaluation_events (id) ON DELETE RESTRICT,
  subject_type TEXT NOT NULL,
  subject_id UUID NOT NULL,
  phase_index SMALLINT,
  skill_path TEXT,
  skill_version TEXT,
  reason TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  original_blob_ref JSONB,
  snapshot_status TEXT NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL DEFAULT 'active',
  status_reason TEXT,
  status_changed_by TEXT REFERENCES app_users (oid) ON DELETE SET NULL,
  status_changed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_skill_regression_cases_event UNIQUE (event_id),
  CONSTRAINT skill_regression_cases_subject_type_check CHECK (
    subject_type IN ('interview_phase', 'prd', 'design_doc', 'test_cases')
  ),
  CONSTRAINT skill_regression_cases_reason_check CHECK (reason IN ('corrected_text', 'low_score', 'both')),
  CONSTRAINT skill_regression_cases_artifact_hash_check CHECK (artifact_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT skill_regression_cases_snapshot_status_check CHECK (
    snapshot_status IN ('pending', 'stored', 'artifact_changed', 'failed')
  ),
  CONSTRAINT skill_regression_cases_snapshot_ref_check CHECK (
    (snapshot_status = 'stored') = (original_blob_ref IS NOT NULL)
  ),
  CONSTRAINT skill_regression_cases_status_check CHECK (status IN ('active', 'retired')),
  CONSTRAINT skill_regression_cases_retire_reason_check CHECK (
    status = 'active' OR length(btrim(coalesce(status_reason, ''))) > 0
  )
);

CREATE INDEX idx_skill_regression_cases_skill
  ON skill_regression_cases (project, skill_path, created_at);

CREATE INDEX idx_skill_regression_cases_snapshot_open
  ON skill_regression_cases (project)
  WHERE snapshot_status IN ('pending', 'failed');

-- Down Migration

DROP TABLE IF EXISTS skill_regression_cases;
