-- Up Migration
-- Promptfoo checks mined from reviewers' corrected text. Proposals are computed on demand;
-- this table holds only a person's decision. Accepted checks join the stage's Promptfoo suite.

CREATE TABLE IF NOT EXISTS skill_mined_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  heading TEXT NOT NULL,
  status TEXT NOT NULL,
  support INTEGER NOT NULL,
  decided_by TEXT REFERENCES app_users(oid) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT skill_mined_checks_status_check CHECK (status IN ('accepted', 'dismissed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_mined_checks_heading
  ON skill_mined_checks (project, stage_key, heading);

-- Down Migration
DROP TABLE IF EXISTS skill_mined_checks;
