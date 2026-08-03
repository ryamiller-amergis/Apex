-- Up Migration
-- FEAT-008 PBI-011: durable append-only anchor-miss diagnostics

CREATE TABLE walkthrough_anchor_misses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  walkthrough_id    UUID NOT NULL REFERENCES walkthroughs(id) ON DELETE CASCADE,
  step_id           UUID NOT NULL REFERENCES walkthrough_steps(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  revision          INTEGER NOT NULL CHECK (revision >= 1),
  project_snapshot  TEXT NOT NULL,
  anchor_key        TEXT NOT NULL,
  target_route      TEXT NOT NULL,
  occurrence_id     UUID NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Idempotent retries for the same render attempt; later replays use a new occurrence_id
  CONSTRAINT uq_walkthrough_anchor_misses_occurrence
    UNIQUE (user_id, walkthrough_id, step_id, revision, occurrence_id)
);

-- Newest-first Platform Admin report reads
CREATE INDEX idx_walkthrough_anchor_misses_walkthrough_occurred
  ON walkthrough_anchor_misses (walkthrough_id, occurred_at DESC, id);

CREATE INDEX idx_walkthrough_anchor_misses_step_revision
  ON walkthrough_anchor_misses (step_id, revision);

-- Down Migration
DROP INDEX IF EXISTS idx_walkthrough_anchor_misses_step_revision;
DROP INDEX IF EXISTS idx_walkthrough_anchor_misses_walkthrough_occurred;
DROP TABLE IF EXISTS walkthrough_anchor_misses;
