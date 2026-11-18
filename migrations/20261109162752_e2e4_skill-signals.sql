-- Up Migration
-- Skill Learning signals: explicit ratings and automatic accept/reject-style
-- events from every covered surface, with the skill version, model and effort
-- that produced the output. Append-only. Surfaces live in code
-- (src/shared/constants/skillLearningSurfaces.ts), so a new surface needs no migration.

CREATE TABLE IF NOT EXISTS skill_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  surface TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  thread_id UUID,
  skill_path TEXT,
  skill_sha256 TEXT,
  model TEXT,
  effort TEXT,
  kind TEXT NOT NULL,
  value SMALLINT,
  actor_id TEXT,
  comment TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_skill_signals_idempotency UNIQUE (idempotency_key),
  CONSTRAINT skill_signals_kind_check CHECK (kind IN (
    'rating', 'accepted', 'rejected', 'regenerated', 'rolled_back',
    'handoff_completed', 'handoff_failed', 'gate_approved', 'gate_rejected',
    'run_failed', 'completed', 'abandoned'
  )),
  CONSTRAINT skill_signals_rating_value_check CHECK (
    (kind = 'rating' AND value BETWEEN -1 AND 1) OR (kind <> 'rating' AND value IS NULL)
  ),
  CONSTRAINT skill_signals_sha_check CHECK (skill_sha256 IS NULL OR skill_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_skill_signals_project_surface_created
  ON skill_signals (project, surface, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_signals_skill_version
  ON skill_signals (project, skill_path, skill_sha256);

CREATE OR REPLACE FUNCTION skill_signals_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'skill_signals rows are append-only'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS skill_signals_append_only ON skill_signals;
CREATE TRIGGER skill_signals_append_only
BEFORE UPDATE ON skill_signals
FOR EACH ROW
EXECUTE PROCEDURE skill_signals_append_only();

-- Down Migration
DROP TRIGGER IF EXISTS skill_signals_append_only ON skill_signals;
DROP FUNCTION IF EXISTS skill_signals_append_only();
DROP TABLE IF EXISTS skill_signals;
