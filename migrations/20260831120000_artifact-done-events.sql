-- Up Migration

-- Immutable done events for pipeline artifacts (FEAT-001 / TBI-002).
--
-- One row per (artifact_type, artifact_id), written once at the transition that
-- makes the artifact done: Interview Mark Complete, owner final approval of a
-- PRD / design prototype / design doc, and a test-case suite reaching 'ready'.
-- The unique constraint plus ON CONFLICT DO NOTHING in
-- artifactDoneEventService is what freezes done_at: a later edit, re-approval,
-- or regeneration cannot move a timestamp a median was already computed from.
--
-- artifact_id is deliberately not a foreign key — it points at one of five
-- tables (interviews, prds, test_cases, design_prototypes, design_docs)
-- depending on artifact_type, and the reading service joins to the matching
-- table for created_at and project scoping.
--
-- No backfill: artifacts that reached their done state before this migration
-- have no event and stay outside the cycle-time population until a
-- post-migration done transition is recorded (assumptions.md U-1).
CREATE TABLE IF NOT EXISTS artifact_done_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_type TEXT NOT NULL CHECK (
    artifact_type IN ('interview', 'prd', 'test_case', 'design_prototype', 'design_doc')
  ),
  artifact_id UUID NOT NULL,
  done_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (artifact_type, artifact_id)
);

-- Supports the per-type rolling-window read: WHERE artifact_type = $1 AND done_at >= $2.
CREATE INDEX IF NOT EXISTS idx_artifact_done_events_type_done_at
  ON artifact_done_events (artifact_type, done_at);

-- Down Migration

DROP TABLE IF EXISTS artifact_done_events;
