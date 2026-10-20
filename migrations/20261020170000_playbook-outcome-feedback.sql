-- Up Migration

-- One outcome record per learning step. Stores the human decision and AI provenance,
-- not prompts, reports, or chain-of-thought.

CREATE TABLE playbook_outcome_feedback (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                  UUID        NOT NULL
                                      REFERENCES playbook_runs(id) ON DELETE CASCADE,
  capture_step_run_id     UUID        NOT NULL UNIQUE
                                      REFERENCES playbook_step_runs(id) ON DELETE CASCADE,
  review_step_run_id      UUID        NOT NULL
                                      REFERENCES playbook_step_runs(id) ON DELETE CASCADE,
  definition_version_id   UUID        NOT NULL
                                      REFERENCES playbook_definition_versions(id) ON DELETE RESTRICT,
  label                   TEXT,
  decision                TEXT        NOT NULL
                                      CHECK (decision IN ('approved', 'rejected')),
  overall_comment         TEXT,
  answers                 JSONB       NOT NULL DEFAULT '[]'::jsonb,
  sources                 JSONB       NOT NULL,
  captured_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT playbook_outcome_feedback_answers_array_check
    CHECK (jsonb_typeof(answers) = 'array'),
  CONSTRAINT playbook_outcome_feedback_sources_array_check
    CHECK (jsonb_typeof(sources) = 'array')
);

CREATE INDEX idx_playbook_outcome_feedback_run
  ON playbook_outcome_feedback (run_id);

-- Down Migration

DROP INDEX IF EXISTS idx_playbook_outcome_feedback_run;
DROP TABLE IF EXISTS playbook_outcome_feedback;
